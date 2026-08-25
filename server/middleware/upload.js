const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Configure Cloudinary from .env ─────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── Image filter (runs before upload, rejects non-images) ──────────────────
const imageFilter = (req, file, cb) => {
  const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const isAllowed = allowedMimeTypes.has(String(file.mimetype || '').toLowerCase())
    && /\.(?:jpe?g|png|webp)$/i.test(String(file.originalname || ''));
  if (isAllowed) return cb(null, true);
  cb(new Error('Only image files are allowed (jpg, png, webp)'));
};

const detectImageType = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  return null;
};

class CloudinaryStorage {
  constructor({ params }) {
    this.params = params;
  }

  _handleFile(req, file, cb) {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cb(error, result);
    };

    Promise.resolve(typeof this.params === 'function' ? this.params(req, file) : this.params)
      .then((params) => {
        const upload = cloudinary.uploader.upload_stream(
          { resource_type: 'image', ...params },
          (error, result) => {
            if (error) return finish(error);
            finish(null, {
              path: result.secure_url,
              filename: result.public_id,
              size: result.bytes,
            });
          },
        );
        file.stream.on('error', finish);
        file.stream.pipe(upload);
      })
      .catch(finish);
  }

  _removeFile(req, file, cb) {
    if (!file.filename) return cb(null);
    cloudinary.uploader.destroy(file.filename).then(() => cb(null)).catch(cb);
  }
}

// ─── Proof image storage (artist uploads approval image) ────────────────────
// Saves to: cloudinary folder "art-studio/proofs"
// Public ID format: proof_order_<orderId>_<timestamp>
// Cloudinary auto-appends the file extension
const proofStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => ({
    folder: 'art-studio/proofs',
    public_id: `proof_order_${req.params.id}_${Date.now()}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ quality: 'auto', fetch_format: 'auto' }],
  }),
});

// ─── Reference photo storage (customer uploads during order) ────────────────
// Saves to: cloudinary folder "art-studio/references"
const refStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => ({
    folder: 'art-studio/references',
    public_id: `ref_${Date.now()}_${file.originalname.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80)}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ quality: 'auto', fetch_format: 'auto' }],
  }),
});

// ─── Profile image storage (avatars) ───────────────────────────────────────
const profileStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => ({
    folder: 'art-studio/profiles',
    public_id: `profile_${req.decodedCustomerId || 'unknown'}_${Date.now()}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 512, height: 512, crop: 'fill', quality: 'auto', fetch_format: 'auto' }],
  }),
});

// ─── Cover image storage ───────────────────────────────────────────────────
const coverStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => ({
    folder: 'art-studio/covers',
    public_id: `cover_${req.decodedCustomerId || 'unknown'}_${Date.now()}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ quality: 'auto', fetch_format: 'auto' }],
  }),
});

const galleryStorage = new CloudinaryStorage({
  cloudinary,
  params: (req) => ({
    folder: 'art-studio/gallery',
    public_id: `gallery_${Date.now()}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ quality: 'auto', fetch_format: 'auto' }],
  }),
});

const reviewStorage = new CloudinaryStorage({
  params: (req) => ({
    folder: 'art-studio/reviews',
    public_id: `review_${req.params.id}_${Date.now()}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ quality: 'auto', fetch_format: 'auto' }],
  }),
});

// ─── Multer instances ────────────────────────────────────────────────────────
// The local Multer storage engine streams files directly to Cloudinary.
// req.file.path  → the full Cloudinary HTTPS URL  (use this to save in DB)
// req.file.filename → the public_id assigned by Cloudinary

const uploadProof = multer({
  storage: proofStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
}).single('proofImage');

const uploadReferences = multer({
  storage: refStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
}).array('referencePhotos', 5);

const uploadProfile = multer({
  // Keep the avatar in memory so the route can either upload it to Cloudinary
  // or safely fall back to the application's local uploads directory.
  storage: multer.memoryStorage(),
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
}).single('profileImage');

const uploadCover = multer({
  storage: coverStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
}).single('coverImage');

const uploadGallery = multer({
  storage: galleryStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('image');

const uploadReview = multer({
  storage: reviewStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('reviewImage');

// ─── Helper: delete an image from Cloudinary by its public_id ───────────────
// Use this if you ever need to replace or remove a stored image.
// public_id is stored in req.file.filename after upload.
const deleteImage = async (publicId) => {
  if (!publicId) return;
  await cloudinary.uploader.destroy(publicId);
};

const uploadProfileImage = async (file, customerId) => {
  const detectedType = detectImageType(file?.buffer);
  if (!detectedType) {
    const error = new Error('The uploaded file is not a valid JPG, PNG, or WebP image.');
    error.statusCode = 400;
    throw error;
  }
  const uploadOptions = {
    folder: 'art-studio/profiles',
    public_id: `profile_${customerId}_${Date.now()}`,
    transformation: [{ width: 512, height: 512, crop: 'fill', quality: 'auto', fetch_format: 'auto' }],
    resource_type: 'image',
  };

  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, uploaded) => {
        if (error) reject(error);
        else resolve(uploaded);
      });
      stream.end(file.buffer);
    });
    return { url: result.secure_url, publicId: result.public_id };
  } catch (cloudinaryError) {
    if (process.env.NODE_ENV === 'production') throw cloudinaryError;
    // Development fallback uses the detected image type, never a user-supplied extension.
    const filename = `profile_${customerId}_${Date.now()}_${crypto.randomUUID()}${detectedType.extension}`;
    const profilesDirectory = path.resolve(__dirname, '..', 'uploads', 'profiles');
    await fs.promises.mkdir(profilesDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(profilesDirectory, filename), file.buffer);
    console.warn('[profile] Cloudinary upload failed; saved avatar locally:', cloudinaryError.message);
    return { url: `/uploads/profiles/${filename}`, publicId: null };
  }
};

module.exports = { uploadProof, uploadReferences, uploadProfile, uploadProfileImage, uploadCover, uploadGallery, uploadReview, deleteImage, cloudinary, detectImageType };
