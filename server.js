import express from 'express';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import fsSync from 'fs';
import { fileURLToPath } from 'url';
import trash from 'trash';
import mime from 'mime-types';
import crypto from 'crypto';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

const app = express();
const PORT = 3000;

// 設定値
const THUMB_DIR = path.join(os.tmpdir(), 'video-dup-thumbs');
const PHASH_HAMMING_THRESHOLD = 5;
const FFMPEG_CONCURRENCY = Number(process.env.FFMPEG_CONCURRENCY) || 3;
const PHASH_DCT_SIZE = 32;
const PHASH_HASH_SIZE = 8;

// プロセス内キャッシュ（永続化なし）
const binaryHashCache = new Map();
const pHashCache = new Map();
const durationCache = new Map();
const thumbnailCache = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- ファイル操作 ----

async function initThumbDir() {
    await fs.mkdir(THUMB_DIR, { recursive: true });
}

async function clearThumbDir() {
    try {
        await fs.rm(THUMB_DIR, { recursive: true, force: true });
    } catch (_) {
        // best-effort
    }
    await initThumbDir();
    thumbnailCache.clear();
}

async function getFileHash(filePath) {
    const size = (await fs.stat(filePath)).size;
    const fd = await fs.open(filePath, 'r');
    const bufferSize = 1024 * 16;
    const buffers = [];

    try {
        const bufStart = Buffer.alloc(Math.min(bufferSize, size));
        await fd.read(bufStart, 0, bufStart.length, 0);
        buffers.push(bufStart);

        if (size > bufferSize * 2) {
            const bufMid = Buffer.alloc(bufferSize);
            await fd.read(bufMid, 0, bufMid.length, Math.floor(size / 2));
            buffers.push(bufMid);
        }

        if (size > bufferSize) {
            const readPos = Math.max(0, size - bufferSize);
            const bufEnd = Buffer.alloc(size - readPos);
            await fd.read(bufEnd, 0, bufEnd.length, readPos);
            buffers.push(bufEnd);
        }
    } finally {
        await fd.close();
    }

    const hash = crypto.createHash('md5');
    hash.update(size.toString());
    for (const buf of buffers) {
        hash.update(buf);
    }
    return hash.digest('hex');
}

async function getFileHashCached(filePath) {
    if (binaryHashCache.has(filePath)) return binaryHashCache.get(filePath);
    const h = await getFileHash(filePath);
    binaryHashCache.set(filePath, h);
    return h;
}

async function getFiles(dir) {
    let results = [];
    const list = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of list) {
        const res = path.resolve(dir, dirent.name);
        if (dirent.isDirectory()) {
            results = results.concat(await getFiles(res));
        } else {
            const mimeType = mime.lookup(res);
            if (mimeType && mimeType.startsWith('video/')) {
                results.push(res);
            }
        }
    }
    return results;
}

// ---- 動画長 / サムネイル ----

async function getDurationSec(filePath) {
    if (durationCache.has(filePath)) return durationCache.get(filePath);
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err || !metadata || !metadata.format) {
                durationCache.set(filePath, null);
                resolve(null);
                return;
            }
            const dur = Number(metadata.format.duration);
            const value = Number.isFinite(dur) && dur > 0 ? dur : null;
            durationCache.set(filePath, value);
            resolve(value);
        });
    });
}

function pickThumbnailTime(durationSec) {
    if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) {
        return 1.0;
    }
    const t = durationSec * 0.1;
    const min = Math.min(1.0, Math.max(0, durationSec - 0.05));
    const max = Math.max(0, durationSec - 0.05);
    return Math.min(max, Math.max(min, t));
}

async function extractThumbnail(filePath, durationSec) {
    if (thumbnailCache.has(filePath)) return thumbnailCache.get(filePath);

    const thumbName = crypto.createHash('md5').update(filePath).digest('hex') + '.jpg';
    const jpgPath = path.join(THUMB_DIR, thumbName);
    const seekTime = pickThumbnailTime(durationSec);

    try {
        await new Promise((resolve, reject) => {
            ffmpeg(filePath)
                .seekInput(seekTime)
                .frames(1)
                .outputOptions(['-q:v', '5', '-vf', 'scale=320:-1'])
                .output(jpgPath)
                .on('end', resolve)
                .on('error', reject)
                .run();
        });
        try {
            await fs.access(jpgPath);
        } catch {
            thumbnailCache.set(filePath, null);
            return null;
        }
        thumbnailCache.set(filePath, jpgPath);
        return jpgPath;
    } catch (e) {
        console.error(`Thumbnail extraction failed: ${filePath}`, e.message || e);
        thumbnailCache.set(filePath, null);
        return null;
    }
}

// ---- pHash ----

async function loadGrayMatrix(jpgPath, size) {
    const buf = await sharp(jpgPath)
        .resize(size, size, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer();
    const out = new Float64Array(size * size);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i];
    return out;
}

function dct1d(vec, N) {
    const out = new Float64Array(N);
    for (let k = 0; k < N; k++) {
        let s = 0;
        for (let n = 0; n < N; n++) {
            s += vec[n] * Math.cos((Math.PI / N) * (n + 0.5) * k);
        }
        out[k] = s;
    }
    return out;
}

function dct2d(input, N) {
    const tmp = new Float64Array(N * N);
    const row = new Float64Array(N);
    for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) row[c] = input[r * N + c];
        const drow = dct1d(row, N);
        for (let c = 0; c < N; c++) tmp[r * N + c] = drow[c];
    }
    const out = new Float64Array(N * N);
    const col = new Float64Array(N);
    for (let c = 0; c < N; c++) {
        for (let r = 0; r < N; r++) col[r] = tmp[r * N + c];
        const dcol = dct1d(col, N);
        for (let r = 0; r < N; r++) out[r * N + c] = dcol[r];
    }
    return out;
}

function buildPHashFromDct(dct, N, hashSize) {
    const values = new Float64Array(hashSize * hashSize);
    for (let r = 0; r < hashSize; r++) {
        for (let c = 0; c < hashSize; c++) {
            values[r * hashSize + c] = dct[r * N + c];
        }
    }
    const sorted = Array.from(values).slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;

    let hash = 0n;
    for (let i = 0; i < values.length; i++) {
        hash <<= 1n;
        if (values[i] > median) hash |= 1n;
    }
    return hash;
}

async function computePHash(filePath, jpgPath) {
    if (pHashCache.has(filePath)) return pHashCache.get(filePath);
    try {
        const matrix = await loadGrayMatrix(jpgPath, PHASH_DCT_SIZE);
        const dct = dct2d(matrix, PHASH_DCT_SIZE);
        const ph = buildPHashFromDct(dct, PHASH_DCT_SIZE, PHASH_HASH_SIZE);
        pHashCache.set(filePath, ph);
        return ph;
    } catch (e) {
        console.error(`pHash failed: ${filePath}`, e.message || e);
        pHashCache.set(filePath, null);
        return null;
    }
}

function hammingDistance(a, b) {
    let x = a ^ b;
    let count = 0;
    while (x !== 0n) {
        x &= x - 1n;
        count++;
    }
    return count;
}

function clusterByPHash(items, threshold) {
    const n = items.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[ra] = rb;
    };

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (hammingDistance(items[i].pHash, items[j].pHash) <= threshold) {
                union(i, j);
            }
        }
    }

    const groups = new Map();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(items[i]);
    }
    return Array.from(groups.values()).filter((g) => g.length >= 2);
}

// ---- 並列実行制限 ----

async function runWithLimit(tasks, concurrency) {
    const results = new Array(tasks.length);
    let next = 0;
    const worker = async () => {
        while (true) {
            const i = next++;
            if (i >= tasks.length) return;
            try {
                results[i] = await tasks[i]();
            } catch (e) {
                results[i] = { __error: e };
            }
        }
    };
    const workers = Array.from(
        { length: Math.min(concurrency, tasks.length) },
        worker
    );
    await Promise.all(workers);
    return results;
}

// ---- API ----

app.get('/api/scan', async (req, res) => {
    const scanPath = req.query.path;
    if (!scanPath) {
        return res.status(400).json({ error: 'Path is required' });
    }

    try {
        await clearThumbDir();
        const files = await getFiles(scanPath);

        // ファイルサイズの取得
        const sizeByPath = new Map();
        for (const file of files) {
            try {
                const stat = await fs.stat(file);
                sizeByPath.set(file, stat.size);
            } catch (e) {
                console.error(`stat failed: ${file}`, e.message || e);
            }
        }
        const validFiles = files.filter((f) => sizeByPath.has(f));

        // メタデータ取得（duration / thumbnail / pHash）
        const tasks = validFiles.map((file) => async () => {
            const dur = await getDurationSec(file);
            const thumb = await extractThumbnail(file, dur);
            const ph = thumb ? await computePHash(file, thumb) : null;
            return {
                path: file,
                size: sizeByPath.get(file),
                durationSec: dur,
                thumbPath: thumb,
                pHash: ph
            };
        });
        const metasRaw = await runWithLimit(tasks, FFMPEG_CONCURRENCY);
        const metas = metasRaw.filter((m) => m && !m.__error);
        const metaByPath = new Map(metas.map((m) => [m.path, m]));

        const fileMeta = (p) => {
            const m = metaByPath.get(p) || { path: p, size: sizeByPath.get(p) };
            return {
                path: m.path,
                size: m.size,
                durationSec: m.durationSec ?? null,
                thumbnailUrl: m.thumbPath
                    ? `/api/thumbnail?path=${encodeURIComponent(m.path)}`
                    : null
            };
        };

        // バイナリ重複検出（既存ロジック）
        const sizeMap = new Map();
        for (const m of metas) {
            if (!sizeMap.has(m.size)) sizeMap.set(m.size, []);
            sizeMap.get(m.size).push(m.path);
        }
        const binaryGroups = [];
        const binaryGroupSets = [];
        for (const [size, fileList] of sizeMap) {
            if (fileList.length < 2) continue;
            const hashMap = new Map();
            for (const file of fileList) {
                try {
                    const hash = await getFileHashCached(file);
                    if (!hashMap.has(hash)) hashMap.set(hash, []);
                    hashMap.get(hash).push(file);
                } catch (e) {
                    console.error(`hash failed: ${file}`, e.message || e);
                }
            }
            for (const [hash, sameHashFiles] of hashMap) {
                if (sameHashFiles.length > 1) {
                    binaryGroups.push({
                        type: 'binary',
                        groupId: `bin-${hash}`,
                        size,
                        hash,
                        files: sameHashFiles.map(fileMeta)
                    });
                    binaryGroupSets.push(new Set(sameHashFiles));
                }
            }
        }

        // 視覚クラスタリング
        const visualCandidates = metas.filter((m) => m.pHash != null);
        const visualClusters = clusterByPHash(
            visualCandidates,
            PHASH_HAMMING_THRESHOLD
        );

        const visualGroups = [];
        let visIdx = 0;
        for (const cluster of visualClusters) {
            const paths = cluster.map((c) => c.path);
            const pathSet = new Set(paths);
            // バイナリグループに完全包含されるなら抑制
            const containedInBinary = binaryGroupSets.some((bs) => {
                if (pathSet.size > bs.size) return false;
                for (const p of pathSet) if (!bs.has(p)) return false;
                return true;
            });
            if (containedInBinary) continue;

            const repSize = Math.max(...paths.map((p) => sizeByPath.get(p) ?? 0));
            visualGroups.push({
                type: 'visual',
                groupId: `vis-${visIdx++}`,
                size: repSize,
                files: paths.map(fileMeta)
            });
        }

        const duplicates = [...binaryGroups, ...visualGroups];
        res.json({ duplicates });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/thumbnail', async (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).send('Missing path');
    const jpgPath = thumbnailCache.get(filePath);
    if (!jpgPath) return res.status(404).send('Not found');
    try {
        await fs.access(jpgPath);
    } catch {
        return res.status(404).send('Not found');
    }
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(jpgPath);
});

app.post('/api/delete', async (req, res) => {
    const { files } = req.body;
    if (!files || !Array.isArray(files)) {
        return res.status(400).json({ error: 'Files array is required' });
    }

    try {
        await trash(files);

        const failed = [];
        for (const file of files) {
            try {
                await fs.access(file);
                failed.push(file);
            } catch {
                // 削除済み
            }
        }

        // 削除されたファイルのキャッシュもクリア
        for (const file of files) {
            if (!failed.includes(file)) {
                binaryHashCache.delete(file);
                pHashCache.delete(file);
                durationCache.delete(file);
                thumbnailCache.delete(file);
            }
        }

        if (failed.length > 0) {
            return res.status(500).json({
                error: '一部のファイルを削除できませんでした。権限を確認してください。',
                failedFiles: failed
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 動画ファイル配信（既存。ディレクトリトラバーサル検証はスコープ外）
app.get('/api/video', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).send('Missing path');
    res.sendFile(filePath);
});

// 起動時にサムネイル一時ディレクトリを初期化
await clearThumbDir();

const cleanup = () => {
    try {
        fsSync.rmSync(THUMB_DIR, { recursive: true, force: true });
    } catch (_) {
        // best-effort
    }
};
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
