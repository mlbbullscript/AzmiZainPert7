/**
 * ============================================================
 *  SIMULASI RACE CONDITION - Sistem Pemesanan Tiket Konser
 * ============================================================
 *
 *  MENGAPA RACE CONDITION BISA TERJADI DI NODE.JS?
 *  ------------------------------------------------
 *  Node.js bersifat single-threaded, artinya hanya ada SATU
 *  thread eksekusi JavaScript. Namun, Node.js menggunakan
 *  EVENT LOOP untuk menangani operasi async (I/O, timer, dll).
 *
 *  Proses Race Condition terjadi karena:
 *
 *  1. READ  → Fungsi A membaca `sisaTiket = 5`
 *  2. YIELD → await delay() menangguhkan fungsi A,
 *             menyerahkan kontrol ke event loop
 *  3. READ  → Fungsi B (juga berjalan) membaca `sisaTiket = 5`
 *             (nilai BELUM berubah karena A belum selesai)
 *  4. WRITE → Fungsi A melanjutkan, menulis `sisaTiket = 4`
 *  5. WRITE → Fungsi B melanjutkan, menulis `sisaTiket = 4`
 *             (harusnya 3, tapi B membaca nilai lama!)
 *
 *  Akibatnya: DUA pemesanan berhasil padahal seharusnya SATU.
 *  Inilah yang menyebabkan OVERSOLD (tiket terjual melebihi stok).
 *
 *  Walaupun tidak ada paralelisme sejati (multithreading),
 *  "interleaving" eksekusi async menciptakan kondisi balapan
 *  yang persis sama dengan race condition di sistem multithreaded.
 * ============================================================
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ── Konfigurasi Simulasi ──────────────────────────────────────
const TOTAL_TIKET    = 100;   // Stok tiket awal
const TOTAL_REQUEST  = 500;   // Jumlah request pemesanan concurrent
const MAX_DELAY_MS   = 10;    // Maksimal async delay (ms) untuk memperparah RC
const LOG_FILE       = path.join(__dirname, "race_condition_log.txt");

// ── State Global (SENGAJA tidak dilindungi / no locking) ──────
let sisaTiket = TOTAL_TIKET;

// ── Array pencatat transaksi ──────────────────────────────────
const transaksiLog = [];

// ─────────────────────────────────────────────────────────────
/**
 * Simulasi async delay — meniru latency I/O nyata (database,
 * network, dsb). Inilah jembatan yang membuat event loop bisa
 * menyela dan mengeksekusi goroutine lain di sela-sela operasi,
 * sehingga Race Condition bisa terjadi.
 *
 * @param {number} ms - Durasi delay dalam milidetik
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
/**
 * Fungsi pemesanan TANPA proteksi apapun.
 *
 * Alur yang RENTAN terhadap Race Condition:
 *   1. Baca  sisaTiket  ← snapshot nilai saat ini
 *   2. await delay()    ← YIELD: event loop bisa jalankan fungsi lain!
 *   3. Cek   snapshot   ← masih pakai nilai LAMA (mungkin sudah stale)
 *   4. Tulis sisaTiket  ← nilai turun dari snapshot, bukan dari state terkini
 *
 * @param {number} userId - ID pengguna yang memesan
 * @returns {Object}      - Hasil transaksi
 */
async function pesanTiket(userId) {
  const waktuMulai = Date.now();

  // LANGKAH 1 — Baca nilai saat ini ke variabel lokal (SNAPSHOT)
  // ⚠️  Nilai ini bisa menjadi STALE setelah await di bawah!
  const snapshotTiket = sisaTiket;

  // LANGKAH 2 — Simulasi I/O latency (misal: query ke database)
  // Di sinilah event loop menyerahkan kontrol ke permintaan lain.
  // Semua fungsi yang sedang "menunggu" bisa berlanjut secara bersamaan.
  await delay(Math.random() * MAX_DELAY_MS);

  // LANGKAH 3 — Cek ketersediaan BERDASARKAN SNAPSHOT (bukan nilai terkini!)
  // ⚠️  Race Condition: snapshot mungkin sudah tidak valid!
  if (snapshotTiket > 0) {
    // LANGKAH 4 — Kurangi sisaTiket (operasi non-atomic)
    // ⚠️  sisaTiket bisa sudah dikurangi oleh permintaan lain sejak step 1!
    sisaTiket = sisaTiket - 1;  // Bukan atomic — bisa terjadi lost update

    const hasil = {
      userId,
      status       : "BERHASIL",
      sisaTiketLog : sisaTiket,   // Nilai setelah pengurangan
      timestamp    : new Date().toISOString(),
      durasiMs     : Date.now() - waktuMulai,
      snapshotAwal : snapshotTiket,
    };
    transaksiLog.push(hasil);
    return hasil;
  } else {
    const hasil = {
      userId,
      status       : "GAGAL - Tiket Habis",
      sisaTiketLog : sisaTiket,
      timestamp    : new Date().toISOString(),
      durasiMs     : Date.now() - waktuMulai,
      snapshotAwal : snapshotTiket,
    };
    transaksiLog.push(hasil);
    return hasil;
  }
}

// ─────────────────────────────────────────────────────────────
/**
 * Tulis log transaksi ke file teks.
 *
 * @param {Object} ringkasan - Objek ringkasan hasil simulasi
 */
function tulisLogKeFile(ringkasan) {
  const header = [
    "=".repeat(70),
    "  RACE CONDITION LOG — Sistem Pemesanan Tiket Konser",
    "=".repeat(70),
    `  Tanggal         : ${new Date().toLocaleString("id-ID")}`,
    `  Stok Awal       : ${TOTAL_TIKET} tiket`,
    `  Total Request   : ${TOTAL_REQUEST} pemesanan concurrent`,
    `  Max Delay       : ${MAX_DELAY_MS} ms`,
    "=".repeat(70),
    "",
    "[ RINGKASAN HASIL ]",
    `  Total Berhasil  : ${ringkasan.totalBerhasil}`,
    `  Total Gagal     : ${ringkasan.totalGagal}`,
    `  Sisa Tiket Final: ${ringkasan.sisaTiketFinal}`,
    `  Oversold?       : ${ringkasan.oversold ? "⚠️  YA — RACE CONDITION TERDETEKSI!" : "Tidak"}`,
    `  Tiket Negatif?  : ${ringkasan.tiketNegatif ? "🔴 YA — sisaTiket < 0!" : "Tidak"}`,
    `  Waktu Eksekusi  : ${ringkasan.waktuEksekusiMs} ms`,
    "",
    "=".repeat(70),
    "[ DETAIL TRANSAKSI ]",
    "=".repeat(70),
    "",
  ].join("\n");

  const baris = transaksiLog.map((t, i) =>
    [
      `[${String(i + 1).padStart(4, "0")}] User-${String(t.userId).padStart(4, "0")}`,
      `  Status      : ${t.status}`,
      `  Snapshot    : ${t.snapshotAwal} (nilai saat dibaca)`,
      `  Sisa Tiket  : ${t.sisaTiketLog} (nilai setelah operasi)`,
      `  Timestamp   : ${t.timestamp}`,
      `  Durasi      : ${t.durasiMs} ms`,
      "",
    ].join("\n")
  );

  const footer = [
    "=".repeat(70),
    "  Penjelasan Race Condition:",
    "  Kolom 'Snapshot' vs 'Sisa Tiket' yang tidak konsisten",
    "  menunjukkan bahwa pembacaan nilai STALE telah terjadi.",
    "  Jika 'Sisa Tiket' < 0, stok negatif telah terjadi (OVERSOLD).",
    "=".repeat(70),
  ].join("\n");

  const konten = header + baris.join("\n") + "\n" + footer;
  fs.writeFileSync(LOG_FILE, konten, "utf-8");
}

// ─────────────────────────────────────────────────────────────
/**
 * Fungsi utama: orkestrasi simulasi Race Condition
 */
async function main() {
  console.log("=".repeat(60));
  console.log("  SIMULASI RACE CONDITION — Pemesanan Tiket Konser");
  console.log("=".repeat(60));
  console.log(`  Stok awal      : ${TOTAL_TIKET} tiket`);
  console.log(`  Total request  : ${TOTAL_REQUEST} concurrent`);
  console.log(`  Max async delay: ${MAX_DELAY_MS} ms`);
  console.log(`  Locking/Queue  : TIDAK ADA ⚠️`);
  console.log("=".repeat(60));
  console.log("\n⏳ Menjalankan simulasi...\n");

  const waktuMulai = Date.now();

  // Buat 500 promise sekaligus — semua mulai BERSAMAAN (concurrent)
  // Promise.all() tidak menunggu satu selesai sebelum memulai berikutnya.
  // Setiap pesanTiket() berjalan di event loop secara interleaved.
  const promises = Array.from({ length: TOTAL_REQUEST }, (_, i) =>
    pesanTiket(i + 1)
  );

  const hasilSemua = await Promise.all(promises);

  const waktuSelesai = Date.now();
  const waktuEksekusiMs = waktuSelesai - waktuMulai;

  // ── Hitung Statistik ────────────────────────────────────────
  const berhasil = hasilSemua.filter((h) => h.status === "BERHASIL");
  const gagal    = hasilSemua.filter((h) => h.status !== "BERHASIL");

  // Cek apakah ada transaksi yang mencatat sisa tiket negatif
  const adaNilaiNegatif = transaksiLog.some((t) => t.sisaTiketLog < 0);

  // Oversold = tiket terjual LEBIH dari stok awal
  const oversold = berhasil.length > TOTAL_TIKET;

  const ringkasan = {
    totalBerhasil  : berhasil.length,
    totalGagal     : gagal.length,
    sisaTiketFinal : sisaTiket,
    oversold,
    tiketNegatif   : adaNilaiNegatif || sisaTiket < 0,
    waktuEksekusiMs,
  };

  // ── Tampilkan Hasil di Console ──────────────────────────────
  console.log("✅ Simulasi selesai!\n");
  console.log("=".repeat(60));
  console.log("  HASIL SIMULASI");
  console.log("=".repeat(60));
  console.log(`  Total terjual      : ${ringkasan.totalBerhasil} tiket`);
  console.log(`  Total gagal        : ${ringkasan.totalGagal} permintaan`);
  console.log(`  Sisa tiket final   : ${ringkasan.sisaTiketFinal}`);
  console.log(`  Oversold?          : ${ringkasan.oversold}`);
  console.log(`  Tiket negatif?     : ${ringkasan.tiketNegatif}`);
  console.log(`  Waktu eksekusi     : ${ringkasan.waktuEksekusiMs} ms`);
  console.log("=".repeat(60));

  if (ringkasan.oversold) {
    console.log("\n⚠️  RACE CONDITION TERDETEKSI!");
    console.log(`   Tiket terjual: ${ringkasan.totalBerhasil} (melebihi stok ${TOTAL_TIKET})`);
    console.log("   Ini terjadi karena banyak async function membaca nilai");
    console.log("   'sisaTiket' yang sama SEBELUM ada yang sempat mengubahnya.");
  } else {
    console.log("\nℹ️  Race condition tidak menghasilkan oversold kali ini.");
    console.log("   Coba jalankan ulang — hasil bisa berbeda setiap run.");
  }

  // ── Simpan Log ke File ──────────────────────────────────────
  tulisLogKeFile(ringkasan);
  console.log(`\n📄 Log transaksi disimpan ke: ${LOG_FILE}`);
  console.log("=".repeat(60));

  // ── Tampilkan 10 Transaksi Pertama sebagai Sampel ───────────
  console.log("\n[ 10 Transaksi Pertama (Sampel) ]");
  console.log("-".repeat(60));
  transaksiLog.slice(0, 10).forEach((t, i) => {
    const label = t.status === "BERHASIL" ? "✅" : "❌";
    console.log(
      `${label} [${i + 1}] User-${String(t.userId).padStart(4, "0")} | ` +
      `Snapshot: ${String(t.snapshotAwal).padStart(3)} → ` +
      `Sisa: ${String(t.sisaTiketLog).padStart(4)} | ` +
      `${t.status}`
    );
  });
  console.log("-".repeat(60));
  console.log("(Lihat file log untuk seluruh transaksi)\n");
}

// ── Entry Point ───────────────────────────────────────────────
main().catch((err) => {
  console.error("❌ Terjadi kesalahan:", err);
  process.exit(1);
});
