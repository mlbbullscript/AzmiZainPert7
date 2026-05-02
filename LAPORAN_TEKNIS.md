# Laporan Teknis: Simulasi Race Condition dan Binary Semaphore
## Sistem Pemesanan Tiket Konser Berbasis Node.js dan RabbitMQ

**Mata Kuliah:** Sistem Paralel & Terdistribusi  
**Pertemuan:** 7  
**Tanggal:** 2 Mei 2026

---

## Daftar Isi

1. [Pendahuluan](#1-pendahuluan)
2. [Arsitektur Sistem](#2-arsitektur-sistem)
3. [Penjelasan Algoritma](#3-penjelasan-algoritma)
4. [Hasil Pengujian](#4-hasil-pengujian)
5. [Analisis Performa](#5-analisis-performa)
6. [Kesimpulan](#6-kesimpulan)
7. [Cara Menjalankan Proyek](#7-cara-menjalankan-proyek)

---

## 1. Pendahuluan

### 1.1 Deskripsi Masalah

Sistem pemesanan tiket konser merupakan salah satu skenario paling rentan terhadap **Race Condition** dalam komputasi modern. Ketika ribuan pengguna mencoba memesan tiket secara bersamaan (*high concurrency*), terdapat risiko bahwa lebih dari satu proses akan membaca nilai stok tiket yang sama pada waktu yang hampir bersamaan, kemudian masing-masing melakukan pengurangan stok secara independen. Akibatnya, sistem dapat menjual tiket melebihi kapasitas yang tersedia (*oversold*).

Contoh skenario nyata:
- Stok tiket tersisa: **1**
- Pengguna A dan B memesan secara hampir bersamaan
- Keduanya membaca stok = 1, keduanya lolos validasi
- Keduanya mengurangi stok → stok menjadi **-1**
- **Dua tiket terjual padahal stok hanya 1**

Permasalahan ini diperparah pada arsitektur berbasis *event-driven* seperti Node.js, di mana operasi asinkron menciptakan jendela waktu (*time window*) yang memungkinkan terjadinya akses bersamaan ke *shared resource*.

### 1.2 Tujuan

Laporan ini mendokumentasikan:
1. Demonstrasi Race Condition pada Node.js menggunakan `async/await` dan `Promise.all()`
2. Solusi menggunakan **RabbitMQ** dengan konfigurasi `prefetch_count=1` sebagai **Binary Semaphore**
3. Perbandingan performa kuantitatif antara kedua pendekatan

### 1.3 Teknologi yang Digunakan

| Teknologi | Versi | Peran |
|-----------|-------|-------|
| **Node.js** | >= 18.x | Runtime JavaScript server-side |
| **RabbitMQ** | 3.x (Docker) | Message broker / Binary Semaphore |
| **amqplib** | ^0.10.4 | Library koneksi AMQP untuk Node.js |
| **Docker** | Terbaru | Kontainer RabbitMQ |

---

## 2. Arsitektur Sistem

### 2.1 Versi Tanpa Queue — Race Condition

```
+------------------------------------------------------------------+
|                    500 Request Concurrent                        |
|  User-001  User-002  User-003   ...   User-499  User-500        |
+----+--------+--------+-------------------+----------+-----------+
     |        |        |                   |          |
     v        v        v                   v          v
  [READ]   [READ]   [READ]    ...       [READ]     [READ]
  stok=100 stok=100 stok=100            stok=100   stok=100
     |        |        |                   |          |
     v        v        v                   v          v
  await    await    await       ...      await      await
  delay()  delay()  delay()              delay()    delay()
  (YIELD ke event loop -- semua concurrent di sini!)
     |        |        |                   |          |
     v        v        v                   v          v
  [CHECK]  [CHECK]  [CHECK]   ...       [CHECK]    [CHECK]
  100>0 v  100>0 v  100>0 v             100>0 v    100>0 v
     |        |        |                   |          |
     v        v        v                   v          v
  [WRITE]  [WRITE]  [WRITE]   ...       [WRITE]    [WRITE]
  stok=99  stok=98  stok=97            stok=-399  stok=-400
                                                    !! OVERSOLD !!

HASIL: 500 terjual, sisa tiket = -400 (DATA RUSAK)
```

Semua fungsi membaca nilai `sisaTiket = 100` sebelum ada yang sempat mengubahnya.

### 2.2 Versi Dengan RabbitMQ — Producer-Consumer

```
+------------------------------------------------------------------+
|                        PRODUCER                                  |
|  Membuat 500 pesan dan mengirim ke queue `ticket_orders`        |
+------------------------------+-----------------------------------+
                               | publish (500 pesan)
                               v
            +-----------------------------------------+
            |         RabbitMQ Queue                  |
            |   [MSG-001][MSG-002][MSG-003]...[MSG-500]|
            |   durable: true                         |
            |   prefetch_count: 1  <-- KUNCI UTAMA    |
            +-----------------------+-----------------+
                                    | kirim 1 pesan
                                    v
            +-----------------------------------------+
            |              CONSUMER                   |
            |  +-----------------------------------+  |
            |  | WAIT / P(s)                       |  |
            |  | Terima MSG-001                    |  |
            |  +-----------------------------------+  |
            |  | CRITICAL SECTION                  |  |
            |  | cek stok -> kurangi 1 jika ada    |  |
            |  +-----------------------------------+  |
            |  | SIGNAL / V(s)                     |  |
            |  | channel.ack(msg)                  |  |
            |  +-----------------------------------+  |
            |  (Baru sekarang MSG-002 dikirim)        |
            +-----------------------------------------+

HASIL: Tepat 100 terjual, 400 ditolak, sisa tiket = 0 (KONSISTEN)
```

### 2.3 Peran `prefetch_count=1` sebagai Binary Semaphore

`prefetch_count=1` menginstruksikan RabbitMQ untuk **tidak mengirim pesan berikutnya** ke consumer hingga pesan sebelumnya mendapat `ack` atau `nack`. Ini secara efektif menciptakan slot semaphore bernilai **1** (binary):

```
Tanpa prefetch_count=1:         Dengan prefetch_count=1:

  MSG-001 --> Consumer            MSG-001 --> Consumer
  MSG-002 --> Consumer  (SALAH)   MSG-002 --> [DIBLOKIR]
  MSG-003 --> Consumer            MSG-003 --> [DIBLOKIR]
  (akses concurrent ke stok)        ack MSG-001
                                  MSG-002 --> Consumer (baru dikirim)
                                  (serial -- no race condition)
```

---

## 3. Penjelasan Algoritma

### 3.1 Mengapa Race Condition Terjadi di Node.js?

Node.js hanya memiliki **satu thread eksekusi JavaScript**, namun menggunakan **Event Loop** untuk menangani operasi asinkron. Inilah yang menciptakan celah Race Condition:

```
TIMELINE EVENT LOOP:

t=0ms  Fungsi-A: READ  sisaTiket=100 (snapshot=100)
t=0ms  Fungsi-B: READ  sisaTiket=100 (snapshot=100) <- nilai SAMA!
t=0ms  Fungsi-A: await delay() -> YIELD
t=0ms  Fungsi-B: await delay() -> YIELD
       ... event loop menjalankan fungsi lain ...
t=7ms  Fungsi-A: RESUME -> CHECK snapshot(100) > 0 OK -> WRITE tiket=99
t=8ms  Fungsi-B: RESUME -> CHECK snapshot(100) > 0 OK -> WRITE tiket=98
       Harusnya B membaca 99 dan menulis 98, ini benar.
       Masalahnya: jika SEMUA 500 fungsi membaca 100 sebelum ada yang
       menulis, maka semua akan LOLOS validasi -> 500 tiket "terjual"!
```

**Faktor kunci:** Operasi Read-Check-Write **bukan atomik**. Kata kunci `await` di antara langkah-langkah tersebut memberikan kesempatan bagi ratusan fungsi lain untuk membaca nilai yang sama.

### 3.2 RabbitMQ Queue + prefetch=1 sebagai Binary Semaphore

Operasi semaphore klasik:
- **P(s) / Wait:** Jika semaphore > 0, kurangi dan lanjutkan. Jika = 0, blokir.
- **V(s) / Signal:** Tambah nilai semaphore; bangunkan proses yang menunggu.

Pemetaan ke RabbitMQ:

| Konsep Semaphore | Implementasi RabbitMQ |
|---|---|
| Semaphore value = 1 | `channel.prefetch(1)` |
| Operasi **P(s) / Wait** | RabbitMQ mengirim pesan ke consumer |
| Critical Section | Blok kode cek-stok dan kurangi tiket |
| Operasi **V(s) / Signal** | `channel.ack(msg)` atau `channel.nack(msg)` |
| Blokir proses lain | Pesan berikutnya tidak dikirim hingga ack |

### 3.3 Perbedaan Mutex vs Semaphore

| Aspek | Mutex | Semaphore |
|---|---|---|
| **Nilai** | Boolean (locked/unlocked) | Integer (0 hingga N) |
| **Kepemilikan** | Hanya pemilik yang bisa unlock | Siapa saja bisa signal |
| **Binary Semaphore** | Setara secara fungsional | Nilai maks = 1 |
| **Implementasi ini** | Bukan Mutex | **Binary Semaphore** |

Implementasi pada proyek ini adalah **Binary Semaphore**: `ack` tidak harus dikirim oleh "pemilik" lock yang sama — mekanisme diatur sepenuhnya oleh broker (RabbitMQ).

### 3.4 Critical Section pada `consumer.js`

```javascript
// CRITICAL SECTION START
// Hanya 1 pesan yang bisa berada di sini pada satu waktu
// karena prefetch(1) memblokir pengiriman pesan berikutnya

if (sisaTiket > 0) {
    sisaTiket--;          // Baca-Modifikasi-Tulis secara SERIAL
    berhasil++;
    channel.ack(msg);     // SIGNAL / V(s) -- lepas slot semaphore
} else {
    ditolak++;
    channel.nack(msg, false, false); // Tolak tanpa requeue
}

// CRITICAL SECTION END
// Setelah ack/nack, RabbitMQ baru mengirim pesan berikutnya
```

**Jaminan keamanan:** Karena `prefetch(1)` memastikan hanya satu pesan *in-flight*, blok kode di atas tidak akan pernah dieksekusi secara bersamaan oleh dua pesan berbeda.

---

## 4. Hasil Pengujian

### 4.1 Tabel Perbandingan Benchmark

> Stok Tiket Awal: **100** | Max Async Delay RC: **10ms**

| Skenario | Versi | Waktu (ms) | Terjual | Ditolak | Sisa Tiket | Konsistensi |
|---|---|---|---|---|---|---|
| 100 req | Tanpa Queue (RC) | 23 | 100 | 0 | 0 | CONSISTENT |
| 100 req | Queue prefetch=1 | 1 | 100 | 0 | 0 | CONSISTENT |
| **500 req** | **Tanpa Queue (RC)** | **16** | **500** | **0** | **-400** | **INCONSISTENT** |
| 500 req | Queue prefetch=1 | 3 | 100 | 400 | 0 | CONSISTENT |
| **1000 req** | **Tanpa Queue (RC)** | **17** | **1000** | **0** | **-900** | **INCONSISTENT** |
| 1000 req | Queue prefetch=1 | 4 | 100 | 900 | 0 | CONSISTENT |

> **Catatan:** Pada 100 request, Race Condition tidak menghasilkan oversold karena probabilistik. Semakin banyak request melebihi stok, semakin pasti Race Condition terjadi.

### 4.2 Contoh Output Konsol

**Versi Tanpa Queue (Race Condition) — `race_condition.js`:**
```
  Total terjual      : 500 tiket
  Sisa tiket final   : -400
  Oversold?          : true
  Tiket negatif?     : true
  Waktu eksekusi     : 24 ms

!! RACE CONDITION TERDETEKSI !!
   Tiket terjual: 500 (melebihi stok 100)

[1] User-0001 | Snapshot: 100 -> Sisa:   99 | BERHASIL
[2] User-0010 | Snapshot: 100 -> Sisa:   98 | BERHASIL
[3] User-0013 | Snapshot: 100 -> Sisa:   97 | BERHASIL
```

Kolom **Snapshot: 100** di setiap baris membuktikan bahwa seluruh 500 fungsi membaca nilai yang sama sebelum ada yang sempat mengubahnya.

**Versi RabbitMQ (Binary Semaphore) — `consumer.js`:**
```
  CONSUMER -- Binary Semaphore via RabbitMQ
  Prefetch    : 1 (Binary Semaphore aktif)
  ACK Mode    : Manual

[001] ORD-00001 | Berhasil | Sisa: 99
[050] ORD-00050 | Berhasil | Sisa: 50
[100] ORD-00100 | Berhasil | Sisa: 0
[101] ORD-00101 | Ditolak (Habis) | Sisa: 0
[102] ORD-00102 | Ditolak (Habis) | Sisa: 0

  Total terjual      : 100 tiket
  Sisa tiket final   : 0
  Oversold?          : false
  Stok negatif?      : false

RACE CONDITION BERHASIL DIATASI!
```

### 4.3 Bukti Konsistensi Data

Pada versi RabbitMQ, nilai `sisaTiket` selalu menurun secara monoton dari 100 ke 0, dan **tidak pernah melampaui batas negatif**:

1. `berhasil` selalu = `min(STOK_AWAL, totalRequest)` = **100**
2. `berhasil + ditolak` = `totalRequest` (tidak ada pesan yang hilang)
3. `sisaTiketFinal` selalu = **0** (bukan negatif)

---

## 5. Analisis Performa

### 5.1 Perbandingan Throughput

| Skenario | Throughput RC | Throughput Queue | Keterangan |
|---|---|---|---|
| 100 req | 4.348 req/s | 100.000 req/s | RC lambat karena delay 10ms/req |
| 500 req | 31.250 req/s | 166.667 req/s | Queue lebih efisien |
| 1000 req | 58.824 req/s | 250.000 req/s | Queue semakin efisien di skala besar |

> Pada deployment RabbitMQ LIVE dengan network, overhead round-trip broker (~1-5ms/pesan) akan lebih terasa. Angka di atas adalah hasil mode simulasi in-process.

### 5.2 Overhead RabbitMQ dan Trade-off

**Sumber overhead pada RabbitMQ LIVE:**
- TCP round-trip ke broker per pesan: ~1-5ms (localhost)
- Serialisasi/deserialisasi JSON: < 0.1ms
- Persistensi ke disk (durable=true): ~0.5-2ms
- **Estimasi total per pesan: 2-8ms**

**Mengapa overhead ini acceptable:**

| Aspek | Tanpa Queue | Dengan Queue |
|---|---|---|
| Kecepatan | Sangat cepat | Sedikit lebih lambat |
| Oversold 500 req | 400 tiket | 0 tiket |
| Kerugian finansial | Nyata dan signifikan | Tidak ada |
| Risiko hukum | Tinggi | Tidak ada |
| Auditability | Tidak ada | Penuh (durable log) |

Overhead beberapa milidetik per transaksi adalah biaya yang jauh lebih murah dibandingkan kompensasi *oversold* dan kerusakan reputasi.

### 5.3 RabbitMQ vs Redis Mutex untuk Use Case Ini

| Kriteria | RabbitMQ prefetch=1 | Redis SET NX / Redlock |
|---|---|---|
| **Mekanisme** | Message Queue + ACK | Distributed Lock |
| **Durability** | Pesan persisten (durable) | Bergantung pada config |
| **Fault Tolerance** | Pesan di-requeue jika crash | Lock bisa expire prematur |
| **Throughput tinggi** | Serial per consumer | Lock granular, bisa paralel |
| **Urutan pemrosesan** | FIFO terjamin | Tidak terjamin |
| **Use case tiket** | **Ideal** | Cocok, tapi lebih kompleks |
| **Kompleksitas** | Rendah | Sedang-Tinggi |

**Rekomendasi:** Gunakan **RabbitMQ** untuk sistem tiket karena:
1. Pesan tidak hilang meski consumer crash (*durable* + manual ACK)
2. Urutan pemrosesan terjamin (FIFO queue)
3. Natural audit trail — setiap transaksi tercatat
4. Mudah di-scale: tambah consumer worker → throughput naik tanpa mengorbankan konsistensi

---

## 6. Kesimpulan

### 6.1 Ringkasan Temuan

Simulasi ini membuktikan secara empiris bahwa:

1. **Race Condition nyata terjadi di Node.js** meski bersifat single-threaded. Mekanisme `async/await` dan Event Loop menciptakan jendela waktu di mana nilai *shared variable* dapat dibaca oleh banyak fungsi sebelum ada yang sempat memodifikasinya.

2. **Dampak Race Condition berbanding lurus dengan jumlah request**: 500 request menghasilkan 400 tiket oversold; 1000 request menghasilkan 900 tiket oversold.

3. **RabbitMQ dengan `prefetch_count=1` secara efektif mengimplementasikan Binary Semaphore** yang menjamin hanya satu operasi kritis berjalan pada satu waktu, menghilangkan kemungkinan Race Condition sepenuhnya.

4. **Konsistensi data terjaga 100%** pada versi RabbitMQ: dari seluruh skenario pengujian, nilai `sisaTiket` tidak pernah turun di bawah 0.

### 6.2 Pentingnya Message Queue pada Sistem High Concurrency

Untuk sistem berbasis Node.js yang menangani *shared mutable state* di bawah beban tinggi, mekanisme sinkronisasi **wajib** diimplementasikan. Message Queue seperti RabbitMQ memberikan:

- **Mutual Exclusion** melalui `prefetch_count` dan manual ACK
- **Durability** melalui queue durable dan pesan persisten
- **Observability** melalui RabbitMQ Management UI
- **Scalability** melalui penambahan consumer worker secara horizontal

> **Prinsip fundamental:** *Kecepatan tanpa kebenaran data bukanlah performa — melainkan kegagalan yang cepat.*

---

## 7. Cara Menjalankan Proyek

### 7.1 Prerequisites

- **Node.js** versi 18.x atau lebih baru
- **Docker Desktop** (untuk RabbitMQ)
- **npm** (bundled dengan Node.js)

```bash
node --version   # harus >= v18.0.0
npm --version    # harus >= 9.0.0
docker --version # Docker Desktop
```

### 7.2 Menjalankan RabbitMQ via Docker

```bash
# Jalankan RabbitMQ dengan Management UI
docker run -d \
  --name rabbitmq-ticket \
  -p 5672:5672 \
  -p 15672:15672 \
  rabbitmq:3-management

# Verifikasi berjalan
docker ps

# Akses Management UI:
# URL      : http://localhost:15672
# Username : guest
# Password : guest

# Menghentikan container
docker stop rabbitmq-ticket

# Menghapus container (reset penuh)
docker rm rabbitmq-ticket
```

### 7.3 Instalasi dan Urutan Menjalankan

```bash
# 1. Masuk ke direktori proyek
cd "Pertemuan 7"

# 2. Install dependencies
npm install

# 3. Simulasi Race Condition saja (standalone)
node race_condition.js

# 4. Jalankan Consumer TERLEBIH DAHULU (Terminal 1)
node consumer.js
# Tunggu hingga muncul: "Menunggu pesan dari producer..."

# 5. Jalankan Producer di terminal terpisah (Terminal 2)
node producer.js

# 6. Jalankan Benchmark
node benchmark.js             # Mode live (butuh RabbitMQ berjalan)
node benchmark.js --simulate  # Mode simulasi (tanpa Docker)
```

### 7.4 Struktur Folder Repository GitHub

```
rabbitmq-ticket-semaphore/
|
+-- race_condition.js       # Simulasi Race Condition (tanpa proteksi)
+-- producer.js             # Mengirim 500 pesan ke RabbitMQ queue
+-- consumer.js             # Memproses pesan satu per satu (Binary Semaphore)
+-- benchmark.js            # Benchmark perbandingan kedua versi
|
+-- package.json            # Dependencies: amqplib ^0.10.4
+-- package-lock.json       # Lock file
|
+-- race_condition_log.txt  # Output log Race Condition (auto-generated)
+-- rabbitmq_log.txt        # Output log RabbitMQ consumer (auto-generated)
+-- benchmark_result.txt    # Hasil benchmark (auto-generated)
|
+-- LAPORAN_TEKNIS.md       # Laporan teknis ini
+-- .gitignore              # Exclude: node_modules/, *.log, *.txt
```

### 7.5 Referensi

| Referensi | URL |
|---|---|
| amqplib Documentation | https://amqp-node.github.io/amqplib/ |
| RabbitMQ Tutorials Node.js | https://www.rabbitmq.com/tutorials/tutorial-one-javascript |
| RabbitMQ Consumer Prefetch | https://www.rabbitmq.com/consumer-prefetch.html |
| Node.js Event Loop | https://nodejs.org/en/docs/guides/event-loop-timers-and-nexttick |
| Semaphore (Wikipedia) | https://en.wikipedia.org/wiki/Semaphore_(programming) |

---

*Laporan ini dibuat sebagai dokumentasi teknis untuk Pertemuan 7 mata kuliah Sistem Paralel & Terdistribusi.*
