/**
 * ============================================================
 *  PRODUCER.JS — RabbitMQ Binary Semaphore
 *  Sistem Pemesanan Tiket Konser (Race Condition Fixed)
 * ============================================================
 *
 *  PERAN PRODUCER:
 *  Producer TIDAK mengakses stok tiket sama sekali.
 *  Tugasnya hanya membuat 500 pesan pemesanan dan
 *  mempublikasikannya ke queue `ticket_orders`.
 *
 *  Dengan RabbitMQ sebagai perantara:
 *  - Semua 500 pesan disimpan di queue (FIFO)
 *  - Consumer memprosesnya SATU PER SATU
 *  - Tidak ada akses concurrent ke variabel stok
 *  → Race Condition TIDAK BISA terjadi
 *
 *  DOCKER COMMAND (jalankan sebelum producer/consumer):
 *  ─────────────────────────────────────────────────────
 *  docker run -d \
 *    --name rabbitmq-ticket \
 *    -p 5672:5672 \
 *    -p 15672:15672 \
 *    rabbitmq:3-management
 *
 *  RabbitMQ Management UI: http://localhost:15672
 *  Default credentials     : guest / guest
 *  ─────────────────────────────────────────────────────
 *
 *  URUTAN MENJALANKAN:
 *  1. docker run ... (lihat command di atas)
 *  2. npm install
 *  3. node consumer.js   (jalankan dulu, tunggu "Menunggu pesan...")
 *  4. node producer.js   (jalankan di terminal terpisah)
 * ============================================================
 */

"use strict";

const amqp = require("amqplib");

// ── Konfigurasi ───────────────────────────────────────────────
const RABBITMQ_URL  = "amqp://localhost";
const QUEUE_NAME    = "ticket_orders";
const TOTAL_ORDERS  = 500;

// ─────────────────────────────────────────────────────────────
/**
 * Fungsi utama producer: membuat koneksi, deklarasi queue,
 * lalu mengirim 500 pesan pemesanan secara berurutan.
 */
async function runProducer() {
  let connection;

  try {
    console.log("=".repeat(60));
    console.log("  PRODUCER — Sistem Pemesanan Tiket Konser");
    console.log("=".repeat(60));
    console.log(`  Queue       : ${QUEUE_NAME}`);
    console.log(`  Total Pesan : ${TOTAL_ORDERS}`);
    console.log("=".repeat(60));

    // ── Buat koneksi ke RabbitMQ ──────────────────────────────
    console.log("\n🔌 Menghubungkan ke RabbitMQ...");
    connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();

    // ── Deklarasi queue (durable: true agar survive restart) ──
    await channel.assertQueue(QUEUE_NAME, {
      durable: true,
      // Jika queue sudah ada, pastikan argumen cocok
    });

    console.log(`✅ Terhubung ke queue '${QUEUE_NAME}'\n`);
    console.log(`📤 Mengirim ${TOTAL_ORDERS} pesan pemesanan...`);

    const waktuMulai = Date.now();

    // ── Kirim 500 pesan ke queue ──────────────────────────────
    for (let i = 1; i <= TOTAL_ORDERS; i++) {
      const pesan = {
        orderId   : `ORD-${String(i).padStart(5, "0")}`,
        userId    : `USER-${String(i).padStart(4, "0")}`,
        timestamp : new Date().toISOString(),
        createdAt : Date.now(),
      };

      // Publish pesan ke queue dengan persistent: true
      // Pesan tidak hilang meski RabbitMQ di-restart
      channel.sendToQueue(
        QUEUE_NAME,
        Buffer.from(JSON.stringify(pesan)),
        { persistent: true }
      );

      // Log setiap 50 pesan agar tidak terlalu verbose
      if (i % 50 === 0 || i === 1) {
        console.log(`   📨 Dikirim ${i}/${TOTAL_ORDERS} pesan`);
      }
    }

    const waktuSelesai = Date.now();

    console.log(`\n✅ Semua ${TOTAL_ORDERS} pesan berhasil dikirim!`);
    console.log(`⏱️  Waktu pengiriman: ${waktuSelesai - waktuMulai} ms`);
    console.log("\n💡 Consumer sedang memproses pesan satu per satu...");
    console.log("   Pantau progres di terminal consumer.\n");

    // Tunggu sebentar agar semua buffer terflushed sebelum menutup
    await new Promise((r) => setTimeout(r, 500));
    await connection.close();
    console.log("🔌 Koneksi producer ditutup.\n");

  } catch (err) {
    console.error("\n❌ Error pada producer:", err.message);
    console.error("\n📌 Pastikan RabbitMQ sudah berjalan dengan:");
    console.error("   docker run -d --name rabbitmq-ticket \\");
    console.error("     -p 5672:5672 -p 15672:15672 \\");
    console.error("     rabbitmq:3-management\n");

    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
    process.exit(1);
  }
}

runProducer();
