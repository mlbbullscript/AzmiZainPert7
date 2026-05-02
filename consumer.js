/**
 * ============================================================
 *  CONSUMER.JS — RabbitMQ Binary Semaphore
 *  Sistem Pemesanan Tiket Konser (Race Condition Fixed)
 * ============================================================
 *
 *  BAGAIMANA RABBITMQ MENYELESAIKAN RACE CONDITION?
 *  ─────────────────────────────────────────────────
 *  RabbitMQ berperan sebagai BINARY SEMAPHORE melalui:
 *
 *  1. prefetch(1) — hanya 1 pesan boleh "in-flight" (diproses)
 *     pada satu waktu. Consumer TIDAK akan menerima pesan
 *     berikutnya hingga ack/nack dikirim.
 *     → Ini setara dengan "slot semaphore = 1" (binary)
 *
 *  2. Manual ACK — consumer secara eksplisit memberitahu
 *     broker bahwa pesan selesai diproses.
 *
 *  Analogi Semaphore:
 *  ┌─────────────────────────────────────────────────┐
 *  │  channel.consume()  → operasi WAIT  / P(s)      │
 *  │  ↓ Pesan masuk      → slot diambil (s = 0)      │
 *  │  ↓ Critical Section → akses eksklusif ke stok   │
 *  │  channel.ack(msg)   → operasi SIGNAL / V(s)     │
 *  │  ↓ Slot dilepas     → pesan berikutnya bisa masuk│
 *  └─────────────────────────────────────────────────┘
 *
 *  Karena hanya 1 pesan diproses sekaligus, tidak ada
 *  dua operasi yang bisa membaca/menulis stok tiket
 *  secara bersamaan → RACE CONDITION TIDAK MUNGKIN TERJADI.
 *
 *  DOCKER COMMAND:
 *  docker run -d --name rabbitmq-ticket \
 *    -p 5672:5672 -p 15672:15672 rabbitmq:3-management
 *
 *  URUTAN MENJALANKAN:
 *  1. docker run ... (lihat atas)
 *  2. npm install
 *  3. node consumer.js   ← jalankan DULU
 *  4. node producer.js   ← jalankan di terminal lain
 * ============================================================
 */

"use strict";

const amqp = require("amqplib");
const fs   = require("fs");
const path = require("path");

// ── Konfigurasi ───────────────────────────────────────────────
const RABBITMQ_URL  = "amqp://localhost";
const QUEUE_NAME    = "ticket_orders";
const TOTAL_TIKET   = 100;       // Stok tiket awal
const TOTAL_EXPECTED = 500;      // Total pesan yang akan datang
const LOG_FILE      = path.join(__dirname, "rabbitmq_log.txt");

// ── State Stok (aman karena hanya diakses 1 pesan sekaligus) ──
let sisaTiket    = TOTAL_TIKET;
let totalBerhasil = 0;
let totalDitolak  = 0;
let totalDiproses = 0;

// ── Array log transaksi ───────────────────────────────────────
const transaksiLog = [];

// ── Timer eksekusi ────────────────────────────────────────────
let waktuMulai;

// ─────────────────────────────────────────────────────────────
/**
 * Tulis semua hasil ke file log.
 * @param {number} waktuEksekusiMs
 */
function tulisLog(waktuEksekusiMs) {
  const ringkasan = [
    "=".repeat(70),
    "  RABBITMQ LOG — Pemesanan Tiket Konser (Binary Semaphore)",
    "=".repeat(70),
    `  Tanggal            : ${new Date().toLocaleString("id-ID")}`,
    `  Stok Awal          : ${TOTAL_TIKET} tiket`,
    `  Total Request      : ${TOTAL_EXPECTED} pesan`,
    `  Mekanisme          : RabbitMQ prefetch(1) = Binary Semaphore`,
    "=".repeat(70),
    "",
    "[ RINGKASAN HASIL ]",
    `  Total Terjual      : ${totalBerhasil}`,
    `  Total Ditolak      : ${totalDitolak}  (tiket habis → NACK)`,
    `  Sisa Tiket Final   : ${sisaTiket}`,
    `  Oversold?          : ${sisaTiket < 0 ? "🔴 YA (BUG!)" : "✅ TIDAK — Stok Aman"}`,
    `  Waktu Eksekusi     : ${waktuEksekusiMs} ms`,
    "",
    "[ BUKTI RACE CONDITION DIATASI ]",
    `  Stok tidak pernah negatif : ${sisaTiket >= 0 ? "✅ BENAR" : "❌ SALAH"}`,
    `  Terjual ≤ Stok Awal       : ${totalBerhasil <= TOTAL_TIKET ? "✅ BENAR" : "❌ SALAH"}`,
    `  Berhasil + Ditolak = Total : ${totalBerhasil + totalDitolak === TOTAL_EXPECTED ? "✅ BENAR" : "❌ SALAH"}`,
    "",
    "=".repeat(70),
    "[ DETAIL TRANSAKSI ]",
    "=".repeat(70),
    "",
  ].join("\n");

  const baris = transaksiLog.map((t, i) =>
    [
      `[${String(i + 1).padStart(4, "0")}] ${t.orderId} | ${t.userId}`,
      `  Status      : ${t.status}`,
      `  Sisa Tiket  : ${t.sisaTiketSetelah}`,
      `  Timestamp   : ${t.timestamp}`,
      `  Durasi      : ${t.durasiMs} ms`,
      "",
    ].join("\n")
  );

  const footer = [
    "=".repeat(70),
    "  Kesimpulan: Dengan prefetch(1), RabbitMQ memastikan hanya",
    "  SATU pesan diproses dalam satu waktu (Binary Semaphore).",
    "  Stok tiket tidak pernah negatif — Race Condition TERATASI.",
    "=".repeat(70),
  ].join("\n");

  fs.writeFileSync(LOG_FILE, ringkasan + baris.join("\n") + "\n" + footer, "utf-8");
}

// ─────────────────────────────────────────────────────────────
/**
 * Tampilkan ringkasan akhir di console dan tutup koneksi.
 * @param {object} connection - Koneksi amqplib
 */
async function tampilkanHasil(connection) {
  const waktuEksekusiMs = Date.now() - waktuMulai;

  console.log("\n" + "=".repeat(60));
  console.log("  HASIL AKHIR SIMULASI");
  console.log("=".repeat(60));
  console.log(`  Total terjual      : ${totalBerhasil} tiket`);
  console.log(`  Total ditolak      : ${totalDitolak} (tiket habis)`);
  console.log(`  Sisa tiket final   : ${sisaTiket}`);
  console.log(`  Oversold?          : ${sisaTiket < 0 ? "🔴 YA (BUG!)" : "false ✅"}`);
  console.log(`  Stok negatif?      : ${sisaTiket < 0 ? "🔴 YA" : "false ✅"}`);
  console.log(`  Waktu eksekusi     : ${waktuEksekusiMs} ms`);
  console.log("=".repeat(60));

  if (sisaTiket >= 0 && totalBerhasil <= TOTAL_TIKET) {
    console.log("\n✅ RACE CONDITION BERHASIL DIATASI!");
    console.log("   Stok tidak pernah negatif berkat Binary Semaphore");
    console.log("   (RabbitMQ prefetch=1 + manual ACK)\n");
  }

  tulisLog(waktuEksekusiMs);
  console.log(`📄 Log disimpan ke: ${LOG_FILE}\n`);

  await connection.close();
  console.log("🔌 Koneksi ditutup. Selesai.\n");
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
/**
 * Fungsi pemrosesan satu pesan pemesanan.
 * Ini adalah CRITICAL SECTION yang dilindungi oleh prefetch(1).
 *
 * @param {object} channel   - amqplib channel
 * @param {object} msg       - Pesan dari RabbitMQ
 * @param {object} connection - Koneksi amqplib (untuk menutup di akhir)
 */
async function prosesPesan(channel, msg, connection) {
  const terimaWaktu = Date.now();
  let data;

  try {
    data = JSON.parse(msg.content.toString());
  } catch {
    // Pesan tidak valid — buang tanpa requeue
    channel.nack(msg, false, false);
    return;
  }

  // ══════════════════════════════════════════════════════════
  // CRITICAL SECTION START
  // ──────────────────────────────────────────────────────────
  // Hanya SATU pesan yang bisa berada di sini pada satu waktu
  // karena prefetch(1) memblokir pengiriman pesan berikutnya
  // hingga ack/nack dikirim (= Binary Semaphore dengan slot=1)
  // ══════════════════════════════════════════════════════════

  totalDiproses++;

  if (sisaTiket > 0) {
    // ── Tiket tersedia → kurangi stok ────────────────────────
    sisaTiket--;
    totalBerhasil++;

    const hasil = {
      orderId          : data.orderId,
      userId           : data.userId,
      status           : "BERHASIL — Tiket Dipesan",
      sisaTiketSetelah : sisaTiket,
      timestamp        : new Date().toISOString(),
      durasiMs         : Date.now() - terimaWaktu,
    };
    transaksiLog.push(hasil);

    // Log setiap 50 transaksi berhasil
    if (totalBerhasil % 50 === 0 || totalBerhasil === 1) {
      console.log(
        `✅ [${String(totalDiproses).padStart(3)}] ${data.orderId} | ` +
        `Berhasil | Sisa: ${sisaTiket}`
      );
    }

    // Operasi SIGNAL / V(s) — Lepas slot semaphore
    // Consumer siap menerima pesan berikutnya dari queue
    channel.ack(msg);

  } else {
    // ── Tiket habis → tolak tanpa requeue ────────────────────
    totalDitolak++;

    const hasil = {
      orderId          : data.orderId,
      userId           : data.userId,
      status           : "DITOLAK — Tiket Habis",
      sisaTiketSetelah : sisaTiket,
      timestamp        : new Date().toISOString(),
      durasiMs         : Date.now() - terimaWaktu,
    };
    transaksiLog.push(hasil);

    if (totalDitolak <= 5 || totalDitolak % 50 === 0) {
      console.log(
        `❌ [${String(totalDiproses).padStart(3)}] ${data.orderId} | ` +
        `Ditolak (Habis) | Sisa: ${sisaTiket}`
      );
    }

    // nack(msg, allUpTo=false, requeue=false)
    // Pesan dibuang — tidak dikembalikan ke queue
    channel.nack(msg, false, false);
  }

  // ══════════════════════════════════════════════════════════
  // CRITICAL SECTION END
  // ══════════════════════════════════════════════════════════

  // Cek apakah semua pesan sudah diproses
  if (totalDiproses >= TOTAL_EXPECTED) {
    await tampilkanHasil(connection);
  }
}

// ─────────────────────────────────────────────────────────────
/**
 * Fungsi utama consumer.
 */
async function runConsumer() {
  let connection;

  try {
    console.log("=".repeat(60));
    console.log("  CONSUMER — Binary Semaphore via RabbitMQ");
    console.log("=".repeat(60));
    console.log(`  Queue       : ${QUEUE_NAME}`);
    console.log(`  Stok Awal   : ${TOTAL_TIKET} tiket`);
    console.log(`  Prefetch    : 1 (Binary Semaphore aktif)`);
    console.log(`  ACK Mode    : Manual`);
    console.log("=".repeat(60));

    // ── Koneksi ke RabbitMQ ───────────────────────────────────
    console.log("\n🔌 Menghubungkan ke RabbitMQ...");
    connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();

    // ── Deklarasi queue ───────────────────────────────────────
    await channel.assertQueue(QUEUE_NAME, { durable: true });

    // ── SET PREFETCH = 1 (IMPLEMENTASI BINARY SEMAPHORE) ──────
    // Ini adalah kunci utama: RabbitMQ hanya akan mengirim
    // 1 pesan ke consumer dalam satu waktu. Pesan ke-2 TIDAK
    // dikirim hingga pesan ke-1 di-ack atau di-nack.
    // Ini menjamin mutual exclusion pada critical section.
    channel.prefetch(1);

    console.log("✅ Terhubung! Menunggu pesan dari producer...");
    console.log("   (Jalankan: node producer.js di terminal lain)\n");

    // ── Mulai consume (Operasi WAIT / P(s)) ───────────────────
    channel.consume(
      QUEUE_NAME,
      (msg) => {
        if (msg === null) return; // Consumer dibatalkan oleh broker

        // Catat waktu mulai saat pesan pertama tiba
        if (totalDiproses === 0) {
          waktuMulai = Date.now();
          console.log("⏱️  Timer mulai — pesan pertama diterima\n");
        }

        // Proses setiap pesan (async — tapi prefetch=1 menjamin
        // tidak ada pesan ke-2 masuk sebelum ack dikirim)
        prosesPesan(channel, msg, connection).catch((err) => {
          console.error("Error prosesPesan:", err.message);
          channel.nack(msg, false, false);
        });
      },
      { noAck: false } // Manual acknowledgment — wajib untuk semaphore
    );

    // Tangani penutupan koneksi yang tidak terduga
    connection.on("close", () => {
      if (totalDiproses < TOTAL_EXPECTED) {
        console.log("\n⚠️  Koneksi RabbitMQ ditutup sebelum semua pesan diproses.");
      }
    });

  } catch (err) {
    console.error("\n❌ Error pada consumer:", err.message);
    console.error("\n📌 Pastikan RabbitMQ sudah berjalan:");
    console.error("   docker run -d --name rabbitmq-ticket \\");
    console.error("     -p 5672:5672 -p 15672:15672 \\");
    console.error("     rabbitmq:3-management\n");

    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
    process.exit(1);
  }
}

runConsumer();
