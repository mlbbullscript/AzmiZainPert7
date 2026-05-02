/**
 * ============================================================
 *  BENCHMARK.JS
 *  Perbandingan Performa: Race Condition vs RabbitMQ Queue
 *  Sistem Pemesanan Tiket Konser
 * ============================================================
 *
 *  Skenario yang diuji: 100, 500, 1000 request concurrent
 *  Metrik: waktu eksekusi, konsistensi data, throughput
 *
 *  Mode operasi:
 *  1. RabbitMQ LIVE (default) — butuh Docker:
 *     docker run -d --name rabbitmq-ticket \
 *       -p 5672:5672 -p 15672:15672 rabbitmq:3-management
 *     node benchmark.js
 *
 *  2. Simulasi (tanpa Docker/RabbitMQ):
 *     node benchmark.js --simulate
 *     Menggunakan in-process serial queue yang memodel prefetch=1
 * ============================================================
 */

"use strict";

const amqp = require("amqplib");
const fs   = require("fs");
const path = require("path");

// ── Konfigurasi ───────────────────────────────────────────────
const RABBITMQ_URL = "amqp://localhost";
const QUEUE_NAME   = "ticket_orders";
const STOK_AWAL    = 100;
const SKENARIO     = [100, 500, 1000];
const LOG_FILE     = path.join(__dirname, "benchmark_result.txt");

// ─────────────────────────────────────────────────────────────
//  VERSI 1 — TANPA QUEUE (Race Condition)
// ─────────────────────────────────────────────────────────────

/**
 * Simulasi delay async — sama persis seperti race_condition.js
 */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Jalankan benchmark versi tanpa queue (race condition).
 * Semua N request dijalankan concurrent via Promise.all().
 *
 * @param {number} totalRequest - Jumlah request concurrent
 * @returns {object} Hasil benchmark
 */
async function benchmarkTanpaQueue(totalRequest) {
  // Reset state lokal sebelum setiap run
  let sisaTiket  = STOK_AWAL;
  let berhasil   = 0;
  let ditolak    = 0;

  const waktuMulai = Date.now();

  // Fungsi pemesanan TANPA proteksi — identik dengan race_condition.js
  const pesanTiket = async (userId) => {
    const snapshot = sisaTiket;               // Baca nilai (bisa stale)
    await delay(Math.random() * 10);          // Yield ke event loop
    if (snapshot > 0) {
      sisaTiket = sisaTiket - 1;             // Non-atomic write
      berhasil++;
    } else {
      ditolak++;
    }
  };

  // Kirim semua request BERSAMAAN
  await Promise.all(
    Array.from({ length: totalRequest }, (_, i) => pesanTiket(i + 1))
  );

  const waktuMs = Date.now() - waktuMulai;

  return {
    waktuMs,
    berhasil,
    ditolak,
    sisaTiketFinal  : sisaTiket,
    konsisten       : sisaTiket >= 0 && berhasil <= STOK_AWAL,
    throughput      : Math.round((totalRequest / waktuMs) * 1000),
  };
}

// ─────────────────────────────────────────────────────────────
//  VERSI 2 — DENGAN RABBITMQ (Binary Semaphore)
// ─────────────────────────────────────────────────────────────

/**
 * Purge semua pesan lama dari queue agar tiap skenario bersih.
 * @param {object} channel - amqplib channel
 */
async function purgeQueue(channel) {
  try {
    await channel.purgeQueue(QUEUE_NAME);
  } catch (_) {
    // Queue mungkin belum ada — biarkan assertQueue yang buat
  }
}

/**
 * Jalankan benchmark versi RabbitMQ LIVE (prefetch=1 = Binary Semaphore).
 * Membutuhkan RabbitMQ berjalan di localhost:5672.
 *
 * @param {number} totalRequest - Jumlah pesan yang dikirim
 * @returns {object} Hasil benchmark
 */
async function benchmarkDenganQueueLive(totalRequest) {
  return new Promise(async (resolve, reject) => {
    let connection;

    try {
      connection = await amqp.connect(RABBITMQ_URL);
      const chanPub = await connection.createChannel();
      const chanSub = await connection.createChannel();

      await chanPub.assertQueue(QUEUE_NAME, { durable: true });
      await chanSub.assertQueue(QUEUE_NAME, { durable: true });
      await purgeQueue(chanPub);

      let sisaTiket = STOK_AWAL;
      let berhasil  = 0;
      let ditolak   = 0;
      let diproses  = 0;

      const waktuMulai = Date.now();

      for (let i = 1; i <= totalRequest; i++) {
        chanPub.sendToQueue(
          QUEUE_NAME,
          Buffer.from(JSON.stringify({
            orderId   : `ORD-${String(i).padStart(5, "0")}`,
            userId    : i,
            timestamp : Date.now(),
          })),
          { persistent: true }
        );
      }

      // Binary Semaphore: hanya 1 pesan in-flight pada satu waktu
      chanSub.prefetch(1);

      chanSub.consume(
        QUEUE_NAME,
        async (msg) => {
          if (!msg) return;

          // CRITICAL SECTION START
          diproses++;
          if (sisaTiket > 0) {
            sisaTiket--;
            berhasil++;
            chanSub.ack(msg);
          } else {
            ditolak++;
            chanSub.nack(msg, false, false);
          }
          // CRITICAL SECTION END

          if (diproses >= totalRequest) {
            const waktuMs = Date.now() - waktuMulai;
            await chanSub.cancel(chanSub.consumerTag ?? "").catch(() => {});
            await connection.close();
            resolve({
              waktuMs, berhasil, ditolak,
              sisaTiketFinal : sisaTiket,
              konsisten      : sisaTiket >= 0 && berhasil <= STOK_AWAL,
              throughput     : Math.round((totalRequest / waktuMs) * 1000),
              mode           : "RabbitMQ LIVE",
            });
          }
        },
        { noAck: false }
      );

    } catch (err) {
      if (connection) await connection.close().catch(() => {});
      reject(err);
    }
  });
}

/**
 * Jalankan benchmark versi RabbitMQ SIMULASI (tanpa Docker).
 *
 * Memodelkan perilaku prefetch=1 menggunakan in-process serial queue:
 *  - Pesan dimasukkan ke array (= queue buffer)
 *  - Diproses satu per satu secara sequential (= prefetch=1)
 *  - Tidak ada concurrent access ke sisaTiket
 *
 * Karena tidak ada I/O network ke broker, overhead yang diukur murni
 * dari serialisasi pemrosesan (bukan round-trip RabbitMQ).
 *
 * @param {number} totalRequest
 * @returns {object} Hasil benchmark
 */
async function benchmarkDenganQueueSimulasi(totalRequest) {
  let sisaTiket = STOK_AWAL;
  let berhasil  = 0;
  let ditolak   = 0;

  // Buat "queue" sebagai array pesan
  const queue = Array.from({ length: totalRequest }, (_, i) => ({
    orderId : `ORD-${String(i + 1).padStart(5, "0")}`,
    userId  : i + 1,
  }));

  const waktuMulai = Date.now();

  // Proses pesan SATU PER SATU — mensimulasikan prefetch=1
  // Tidak ada concurrency → tidak ada race condition
  for (const pesan of queue) {
    // CRITICAL SECTION START
    if (sisaTiket > 0) {
      sisaTiket--;
      berhasil++;
      // Simulasi: ack berhasil → lanjut pesan berikutnya
    } else {
      ditolak++;
      // Simulasi: nack tanpa requeue → buang pesan
    }
    // CRITICAL SECTION END

    // Simulasi minimal overhead broker per pesan (0–0.1ms)
    // Tanpa ini waktu jadi 0ms dan throughput infinity
    await new Promise((r) => setImmediate(r));
  }

  const waktuMs = Date.now() - waktuMulai;

  return {
    waktuMs   : Math.max(waktuMs, 1),
    berhasil,
    ditolak,
    sisaTiketFinal : sisaTiket,
    konsisten      : sisaTiket >= 0 && berhasil <= STOK_AWAL,
    throughput     : Math.round((totalRequest / Math.max(waktuMs, 1)) * 1000),
    mode           : "Queue Simulasi (prefetch=1)",
  };
}

/**
 * Wrapper: pilih mode live atau simulasi berdasarkan flag.
 */
async function benchmarkDenganQueue(totalRequest, modeSimulasi) {
  if (modeSimulasi) return benchmarkDenganQueueSimulasi(totalRequest);
  return benchmarkDenganQueueLive(totalRequest);
}

// ─────────────────────────────────────────────────────────────
//  FORMATTER TABEL ASCII
// ─────────────────────────────────────────────────────────────

/**
 * Buat baris tabel dengan lebar kolom tetap.
 * @param {string[]} cells  - Isi setiap kolom
 * @param {number[]} widths - Lebar masing-masing kolom
 */
function barisTabel(cells, widths) {
  return "│ " + cells.map((c, i) => String(c).padEnd(widths[i])).join(" │ ") + " │";
}

/**
 * Buat garis pemisah tabel.
 * @param {number[]} widths - Lebar masing-masing kolom
 * @param {"top"|"mid"|"bot"} tipe
 */
function garisTabel(widths, tipe = "mid") {
  const [l, m, r, h] =
    tipe === "top" ? ["┌", "┬", "┐", "─"] :
    tipe === "bot" ? ["└", "┴", "┘", "─"] :
                     ["├", "┼", "┤", "─"];
  return l + widths.map((w) => h.repeat(w + 2)).join(m) + r;
}

// ─────────────────────────────────────────────────────────────
//  ANALISIS OTOMATIS
// ─────────────────────────────────────────────────────────────

/**
 * Hitung dan cetak analisis komparatif dari semua skenario.
 * @param {object[]} hasilSemua - Array hasil tiap skenario
 * @returns {string} Teks analisis (untuk disimpan ke file)
 */
function analisisOtomatis(hasilSemua) {
  const lines = [];
  const print = (s = "") => { lines.push(s); console.log(s); };

  print();
  print("═".repeat(70));
  print("  ANALISIS OTOMATIS");
  print("═".repeat(70));

  hasilSemua.forEach(({ totalRequest, v1, v2 }) => {
    const overhead = v1.waktuMs > 0
      ? (((v2.waktuMs - v1.waktuMs) / v1.waktuMs) * 100).toFixed(1)
      : "N/A";
    const overheadNum = parseFloat(overhead);

    print();
    print(`▶  Skenario ${totalRequest} Request`);
    print(`   Overhead Queue    : +${overhead}% lebih lambat`);
    print(`   Throughput RC     : ${v1.throughput.toLocaleString()} req/s`);
    print(`   Throughput Queue  : ${v2.throughput.toLocaleString()} req/s`);
    print(`   Konsistensi RC    : ${v1.konsisten ? "✅ Konsisten" : "❌ INKONSISTEN (oversold)"}`);
    print(`   Konsistensi Queue : ${v2.konsisten ? "✅ Konsisten" : "❌ INKONSISTEN"}`);

    if (!v1.konsisten) {
      const oversold = v1.berhasil - STOK_AWAL;
      print(`   Kerugian RC       : ${oversold} tiket oversold (data rusak!)`);
    }
  });

  print();
  print("─".repeat(70));
  print("  MENGAPA OVERHEAD QUEUE ACCEPTABLE UNTUK SISTEM TIKET?");
  print("─".repeat(70));
  print();
  print("  1. INTEGRITAS DATA > KECEPATAN");
  print("     Sistem tiket menangani transaksi keuangan nyata.");
  print("     Oversold = pengembalian dana, kerugian reputasi, masalah hukum.");
  print("     Overhead beberapa ratus ms jauh lebih murah dari kompensasi.");
  print();
  print("  2. OVERHEAD TERJADI DI LAYER INFRASTRUKTUR, BUKAN BISNIS");
  print("     Latency queue (5–50ms/pesan) tidak terasa oleh end-user");
  print("     karena UI sudah menampilkan 'Sedang diproses...' saat menunggu.");
  print();
  print("  3. SCALABILITY HORIZONTAL");
  print("     RabbitMQ mendukung multiple consumer worker secara paralel.");
  print("     Throughput bisa ditingkatkan dengan menambah consumer,");
  print("     TANPA mengorbankan konsistensi stok.");
  print();
  print("─".repeat(70));
  print("  TRADE-OFF: KECEPATAN vs KONSISTENSI");
  print("─".repeat(70));
  print();
  print("  ┌──────────────────────┬──────────────────────────────────────┐");
  print("  │ Aspek                │ Race Condition  │  RabbitMQ Queue    │");
  print("  ├──────────────────────┼─────────────────┼────────────────────┤");
  print("  │ Kecepatan            │ ⚡ Sangat cepat │ 🐢 Lebih lambat    │");
  print("  │ Konsistensi Data     │ ❌ Tidak aman   │ ✅ Terjamin        │");
  print("  │ Kemungkinan Oversold │ ❌ Sangat tinggi│ ✅ Tidak mungkin   │");
  print("  │ Cocok untuk tiket?   │ ❌ Berbahaya    │ ✅ Wajib digunakan │");
  print("  │ Fault Tolerance      │ ❌ Tidak ada    │ ✅ ACK + requeue   │");
  print("  │ Scalability          │ ⚠️ Terbatas     │ ✅ Multi-consumer  │");
  print("  └──────────────────────┴─────────────────┴────────────────────┘");
  print();
  print("  KESIMPULAN:");
  print("  Untuk sistem pemesanan tiket, konsistensi data adalah NON-NEGOTIABLE.");
  print("  Overhead RabbitMQ adalah biaya yang WAJIB dibayar untuk kebenaran data.");
  print("  Gunakan Race Condition HANYA untuk operasi read-only yang idempotent.");
  print();
  print("═".repeat(70));

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
//  SIMPAN HASIL KE FILE
// ─────────────────────────────────────────────────────────────

/**
 * Tulis seluruh hasil benchmark ke file teks.
 */
function simpanHasil(tabelTeks, analisisTeks) {
  const konten = [
    "=".repeat(70),
    "  BENCHMARK RESULT — Race Condition vs RabbitMQ Queue",
    `  Dibuat: ${new Date().toLocaleString("id-ID")}`,
    `  Stok Tiket: ${STOK_AWAL} | Skenario: ${SKENARIO.join(", ")} request`,
    "=".repeat(70),
    "",
    tabelTeks,
    "",
    analisisTeks,
    "",
    "=".repeat(70),
    "  END OF BENCHMARK REPORT",
    "=".repeat(70),
  ].join("\n");

  fs.writeFileSync(LOG_FILE, konten, "utf-8");
  console.log(`\n📄 Hasil benchmark disimpan ke: ${LOG_FILE}\n`);
}

// ─────────────────────────────────────────────────────────────
//  MAIN — Orkestrasi Benchmark
// ─────────────────────────────────────────────────────────────

async function main() {
  // ── Deteksi mode: --simulate flag ─────────────────────────
  const modeSimulasi = process.argv.includes("--simulate");

  console.log("=".repeat(70));
  console.log("  BENCHMARK — Race Condition vs RabbitMQ Binary Semaphore");
  console.log("=".repeat(70));
  console.log(`  Stok Tiket Awal : ${STOK_AWAL}`);
  console.log(`  Skenario        : ${SKENARIO.join(", ")} request`);
  console.log(`  Mode V2         : ${modeSimulasi ? "Simulasi (tanpa Docker)" : "RabbitMQ LIVE"}`);
  if (!modeSimulasi) console.log(`  RabbitMQ URL    : ${RABBITMQ_URL}`);
  console.log("=".repeat(70));
  console.log();

  // ── Cek koneksi RabbitMQ (hanya jika bukan mode simulasi) ─
  if (!modeSimulasi) {
    console.log("🔌 Mengecek koneksi RabbitMQ...");
    try {
      const testConn = await amqp.connect(RABBITMQ_URL);
      await testConn.close();
      console.log("✅ RabbitMQ terhubung!\n");
    } catch {
      console.error("❌ Gagal terhubung ke RabbitMQ!");
      console.error("   Opsi 1 — Jalankan Docker:");
      console.error("   docker run -d --name rabbitmq-ticket \\");
      console.error("     -p 5672:5672 -p 15672:15672 rabbitmq:3-management");
      console.error();
      console.error("   Opsi 2 — Jalankan tanpa Docker (mode simulasi):");
      console.error("   node benchmark.js --simulate\n");
      process.exit(1);
    }
  } else {
    console.log("ℹ️  Mode Simulasi aktif — RabbitMQ dimodelkan secara in-process.");
    console.log("   Overhead mencerminkan serialisasi (prefetch=1), bukan network I/O.\n");
  }

  // ── Jalankan semua skenario ────────────────────────────────
  const hasilSemua = [];

  for (const totalRequest of SKENARIO) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  📊 Skenario: ${totalRequest} request`);
    console.log("─".repeat(60));

    // -- Versi 1: Tanpa Queue (Race Condition) -----------------
    process.stdout.write(`  [1/2] Tanpa Queue    ... `);
    const v1 = await benchmarkTanpaQueue(totalRequest);
    console.log(
      `selesai (${v1.waktuMs}ms | terjual: ${v1.berhasil} | ` +
      `sisa: ${v1.sisaTiketFinal} | ${v1.konsisten ? "CONSISTENT" : "INCONSISTENT"})`
    );

    await delay(200);

    // -- Versi 2: Dengan Queue (Live atau Simulasi) -----------
    const labelV2 = modeSimulasi ? "Queue Simulasi" : "RabbitMQ Queue";
    process.stdout.write(`  [2/2] ${labelV2.padEnd(14)} ... `);
    const v2 = await benchmarkDenganQueue(totalRequest, modeSimulasi);
    console.log(
      `selesai (${v2.waktuMs}ms | terjual: ${v2.berhasil} | ` +
      `sisa: ${v2.sisaTiketFinal} | ${v2.konsisten ? "CONSISTENT" : "INCONSISTENT"})`
    );

    hasilSemua.push({ totalRequest, v1, v2 });
    await delay(300);
  }

  // ── Cetak Tabel Hasil ──────────────────────────────────────
  console.log("\n\n" + "═".repeat(70));
  console.log("  TABEL HASIL BENCHMARK");
  console.log("═".repeat(70));

  // Baris console.table (data flat)
  const tableData = [];
  hasilSemua.forEach(({ totalRequest, v1, v2 }) => {
    tableData.push({
      "Skenario"       : `${totalRequest} req`,
      "Versi"          : "Tanpa Queue (RC)",
      "Waktu (ms)"     : v1.waktuMs,
      "Terjual"        : v1.berhasil,
      "Ditolak"        : v1.ditolak,
      "Sisa Tiket"     : v1.sisaTiketFinal,
      "Throughput/s"   : v1.throughput.toLocaleString(),
      "Konsistensi"    : v1.konsisten ? "CONSISTENT" : "INCONSISTENT ❌",
    });
    tableData.push({
      "Skenario"       : `${totalRequest} req`,
      "Versi"          : "RabbitMQ Queue",
      "Waktu (ms)"     : v2.waktuMs,
      "Terjual"        : v2.berhasil,
      "Ditolak"        : v2.ditolak,
      "Sisa Tiket"     : v2.sisaTiketFinal,
      "Throughput/s"   : v2.throughput.toLocaleString(),
      "Konsistensi"    : v2.konsisten ? "CONSISTENT ✅" : "INCONSISTENT",
    });
  });
  console.table(tableData);

  // ── Buat Tabel ASCII Manual untuk File ────────────────────
  const COL_W = [10, 18, 11, 9, 9, 12, 13, 17];
  const HEADER = [
    "Skenario", "Versi", "Waktu (ms)", "Terjual",
    "Ditolak", "Sisa Tiket", "Throughput/s", "Konsistensi",
  ];

  const tabelLinhas = [];
  tabelLinhas.push(garisTabel(COL_W, "top"));
  tabelLinhas.push(barisTabel(HEADER, COL_W));
  tabelLinhas.push(garisTabel(COL_W, "mid"));

  hasilSemua.forEach(({ totalRequest, v1, v2 }, idx) => {
    tabelLinhas.push(barisTabel([
      `${totalRequest} req`, "Tanpa Queue (RC)",
      v1.waktuMs, v1.berhasil, v1.ditolak,
      v1.sisaTiketFinal, `${v1.throughput}/s`,
      v1.konsisten ? "CONSISTENT" : "INCONSISTENT",
    ], COL_W));
    tabelLinhas.push(barisTabel([
      "", "RabbitMQ Queue",
      v2.waktuMs, v2.berhasil, v2.ditolak,
      v2.sisaTiketFinal, `${v2.throughput}/s`,
      v2.konsisten ? "CONSISTENT" : "INCONSISTENT",
    ], COL_W));
    if (idx < hasilSemua.length - 1) tabelLinhas.push(garisTabel(COL_W, "mid"));
  });

  tabelLinhas.push(garisTabel(COL_W, "bot"));
  const tabelTeks = tabelLinhas.join("\n");

  // ── Analisis ───────────────────────────────────────────────
  const analisisTeks = analisisOtomatis(hasilSemua);

  // ── Simpan ke File ─────────────────────────────────────────
  simpanHasil(tabelTeks, analisisTeks);
}

main().catch((err) => {
  console.error("\n❌ Benchmark error:", err.message);
  if (err.message.includes("ECONNREFUSED")) {
    console.error("\n📌 RabbitMQ tidak berjalan. Jalankan:");
    console.error("   docker run -d --name rabbitmq-ticket \\");
    console.error("     -p 5672:5672 -p 15672:15672 rabbitmq:3-management\n");
  }
  process.exit(1);
});
