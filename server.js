import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { fileURLToPath } from 'url';
import trash from 'trash';
import mime from 'mime-types';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to calculate file hash (partial for speed, or full)
// For video files, full hash is slow. We can hash the first 1MB and last 1MB + size.
// Or just full hash if we want to be 100% sure.
// Let's do a partial hash: first 16kb, middle 16kb, last 16kb.
async function getFileHash(filePath) {
    const size = (await fs.stat(filePath)).size;
    const fd = await fs.open(filePath, 'r');
    const bufferSize = 1024 * 16; // 16KB
    const buffers = [];

    try {
        // Read start
        const bufStart = Buffer.alloc(Math.min(bufferSize, size));
        await fd.read(bufStart, 0, bufStart.length, 0);
        buffers.push(bufStart);

        // Read middle
        if (size > bufferSize * 2) {
            const bufMid = Buffer.alloc(bufferSize);
            await fd.read(bufMid, 0, bufMid.length, Math.floor(size / 2));
            buffers.push(bufMid);
        }

        // Read end
        if (size > bufferSize) {
            const bufEnd = Buffer.alloc(Math.min(bufferSize, size - bufferSize)); // simplistic
            // Actually just read the last chunk
            const readPos = Math.max(0, size - bufferSize);
            const bufEndActual = Buffer.alloc(size - readPos);
            await fd.read(bufEndActual, 0, bufEndActual.length, readPos);
            buffers.push(bufEndActual);
        }
    } finally {
        await fd.close();
    }

    const hash = crypto.createHash('md5');
    hash.update(size.toString()); // Include size in hash
    for (const buf of buffers) {
        hash.update(buf);
    }
    return hash.digest('hex');
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

app.get('/api/scan', async (req, res) => {
    const scanPath = req.query.path;
    if (!scanPath) {
        return res.status(400).json({ error: 'Path is required' });
    }

    try {
        const files = await getFiles(scanPath);
        const fileMap = new Map();

        // First pass: Group by size
        const sizeMap = new Map();
        for (const file of files) {
            const stat = await fs.stat(file);
            const size = stat.size;
            if (!sizeMap.has(size)) {
                sizeMap.set(size, []);
            }
            sizeMap.get(size).push(file);
        }

        // Second pass: Hash files with same size
        const duplicates = [];
        for (const [size, fileList] of sizeMap) {
            if (fileList.length < 2) continue;

            const hashMap = new Map();
            for (const file of fileList) {
                try {
                    const hash = await getFileHash(file);
                    if (!hashMap.has(hash)) {
                        hashMap.set(hash, []);
                    }
                    hashMap.get(hash).push(file);
                } catch (e) {
                    console.error(`Error processing file ${file}:`, e);
                }
            }

            for (const [hash, sameHashFiles] of hashMap) {
                if (sameHashFiles.length > 1) {
                    const fileObjs = sameHashFiles.map(f => ({ path: f, size }));
                    duplicates.push({
                        size: size,
                        hash: hash,
                        files: fileObjs
                    });
                }
            }
        }

        res.json({ duplicates });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/delete', async (req, res) => {
    const { files } = req.body;
    if (!files || !Array.isArray(files)) {
        return res.status(400).json({ error: 'Files array is required' });
    }

    try {
        await trash(files);
        
        // Verify deletion
        const failed = [];
        for (const file of files) {
            try {
                await fs.access(file);
                failed.push(file);
            } catch {
                // File gone
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

// Serve video files for thumbnail preview
app.get('/api/video', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) {
        return res.status(400).send('Missing path');
    }
    // In production, validate the path to prevent directory traversal.
    res.sendFile(filePath);
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
