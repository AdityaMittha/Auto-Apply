/**
 * S3 Storage Module
 * 
 * Manages uploading tailored resume PDFs, base templates, applied jobs database,
 * and reports to Amazon S3. Generates pre-signed URLs for email digests.
 */

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const E = loadEnv();
const S3_BUCKET = E.S3_BUCKET_NAME || 'auto-apply-aditya-mittha';
const AWS_REGION = E.AWS_REGION || process.env.AWS_REGION || 'ap-south-1';

let s3Client = null;

function getS3Client() {
  if (s3Client) return s3Client;
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    const clientConfig = { region: AWS_REGION };
    if (E.AWS_ACCESS_KEY_ID && E.AWS_SECRET_ACCESS_KEY) {
      clientConfig.credentials = {
        accessKeyId: E.AWS_ACCESS_KEY_ID,
        secretAccessKey: E.AWS_SECRET_ACCESS_KEY,
      };
    }
    s3Client = new S3Client(clientConfig);
    return s3Client;
  } catch (err) {
    return null;
  }
}

/**
 * Uploads a local file to S3.
 * @param {string} localPath - Absolute path to local file
 * @param {string} s3Key - S3 Object key (path in bucket)
 * @param {string} [contentType] - MIME type
 * @returns {Promise<string|null>} S3 URI or null on failure
 */
async function uploadFile(localPath, s3Key, contentType = 'application/pdf') {
  if (!fs.existsSync(localPath)) return null;
  const client = getS3Client();
  if (!client) return null;

  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const fileStream = fs.createReadStream(localPath);
    const cmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: fileStream,
      ContentType: contentType,
    });
    await client.send(cmd);
    return `s3://${S3_BUCKET}/${s3Key}`;
  } catch (err) {
    console.error(`[S3] Upload error for ${s3Key}:`, err.message);
    return null;
  }
}

/**
 * Uploads JSON object directly to S3.
 * @param {object} jsonData 
 * @param {string} s3Key 
 * @returns {Promise<string|null>}
 */
async function uploadJson(jsonData, s3Key) {
  const client = getS3Client();
  if (!client) return null;

  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const cmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: JSON.stringify(jsonData, null, 2),
      ContentType: 'application/json',
    });
    await client.send(cmd);
    return `s3://${S3_BUCKET}/${s3Key}`;
  } catch (err) {
    console.error(`[S3] Upload JSON error for ${s3Key}:`, err.message);
    return null;
  }
}

/**
 * Generates a pre-signed URL to download an S3 object.
 * @param {string} s3Key 
 * @param {number} [expiresInSeconds=604800] 7 days by default
 * @returns {Promise<string|null>}
 */
async function getPresignedDownloadUrl(s3Key, expiresInSeconds = 604800) {
  const client = getS3Client();
  if (!client) return null;

  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const cmd = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
    });
    return await getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
  } catch (err) {
    return null;
  }
}

/**
 * Syncs all tailored resume PDFs from local folder to S3.
 * @returns {Promise<number>} Number of synced resumes
 */
async function syncTailoredResumes() {
  const tailoredDir = path.join(__dirname, 'resume', 'tailored');
  if (!fs.existsSync(tailoredDir)) return 0;

  const files = fs.readdirSync(tailoredDir).filter(f => f.endsWith('.pdf'));
  let count = 0;
  for (const f of files) {
    const localPath = path.join(tailoredDir, f);
    const s3Key = `resumes/tailored/${f}`;
    const res = await uploadFile(localPath, s3Key, 'application/pdf');
    if (res) count++;
  }

  // Also backup applied-jobs.json
  const appliedJson = path.join(__dirname, 'applied-jobs.json');
  if (fs.existsSync(appliedJson)) {
    try {
      const data = JSON.parse(fs.readFileSync(appliedJson, 'utf8'));
      await uploadJson(data, 'data/applied-jobs.json');
    } catch {}
  }

  return count;
}

module.exports = {
  uploadFile,
  uploadJson,
  getPresignedDownloadUrl,
  syncTailoredResumes,
  S3_BUCKET,
  AWS_REGION,
};
