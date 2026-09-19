const { google } = require('googleapis');
const { Readable } = require('stream');

// Same Service Account credentials pattern as HRMS - set as ONE
// environment variable containing the whole downloaded key file's
// content. This can reuse the exact same Service Account as HRMS (the
// GOOGLE_SERVICE_ACCOUNT_JSON value can be copied over as-is), since a
// Service Account can access multiple Shared Drives - what matters is
// this app gets its OWN Shared Drive folder for receipts, kept
// separate from HRMS's "Offer Letters"/"Salary Slips" folders.
let driveClient = null;

function getDriveClient() {
  if (driveClient) return driveClient;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

const subfolderCache = {};

/**
 * Finds a subfolder by name directly inside the main Drive folder,
 * creating it if it doesn't exist yet. Cached in memory after the first
 * lookup. Used here as: Year / Trip_<code> / receipt_*.jpg, matching
 * the original Apps Script design's organization.
 */
async function getOrCreateSubfolder(name, parentId) {
  const cacheKey = parentId + '/' + name;
  if (subfolderCache[cacheKey]) return subfolderCache[cacheKey];

  const drive = getDriveClient();

  const existing = await drive.files.list({
    q: `name = '${name}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  if (existing.data.files && existing.data.files.length > 0) {
    subfolderCache[cacheKey] = existing.data.files[0].id;
    return subfolderCache[cacheKey];
  }

  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true
  });
  subfolderCache[cacheKey] = created.data.id;
  return subfolderCache[cacheKey];
}

/**
 * Uploads a receipt photo, organized as Year / Trip_<code> / filename,
 * makes it viewable by anyone with the link, and returns that link.
 * Returns null if Drive isn't configured.
 */
async function uploadReceiptToDrive(buffer, filename, mimeType, tripCode) {
  const drive = getDriveClient();
  if (!drive) return null;

  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!rootFolderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set');

  const year = String(new Date().getFullYear());
  const yearFolderId = await getOrCreateSubfolder(year, rootFolderId);
  const tripFolderId = await getOrCreateSubfolder('Trip_' + tripCode, yearFolderId);

  const stream = Readable.from(buffer);

  const file = await drive.files.create({
    requestBody: { name: filename, parents: [tripFolderId] },
    media: { mimeType, body: stream },
    fields: 'id, webViewLink',
    supportsAllDrives: true
  });

  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true
  });

  return file.data.webViewLink;
}

function isDriveConfigured() {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !!process.env.GOOGLE_DRIVE_FOLDER_ID;
}

/** Pulls the file ID out of a Drive webViewLink, e.g. .../file/d/FILE_ID/view */
function extractDriveFileId(url) {
  if (!url) return null;
  const match = url.match(/\/file\/d\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Downloads a receipt photo's raw bytes back out of Drive, for
 * embedding in the PDF. Returns null (never throws) if anything goes
 * wrong - one missing/broken photo shouldn't take down the whole PDF,
 * the caller just skips that one and carries on.
 */
async function downloadReceiptFromDrive(driveUrl) {
  try {
    const fileId = extractDriveFileId(driveUrl);
    if (!fileId) return null;
    const drive = getDriveClient();
    if (!drive) return null;

    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data);
  } catch (err) {
    console.error('Could not download receipt from Drive:', err.message);
    return null;
  }
}

module.exports = { uploadReceiptToDrive, isDriveConfigured, downloadReceiptFromDrive };
