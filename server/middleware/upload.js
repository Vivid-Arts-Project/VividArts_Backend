const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;

// ─── Configure Cloudinary from .env ─────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── Image filter (runs before upload, rejects non-images) ──────────────────
const imageFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const isAllowed =
    allowed.test(file.mimetype) &&
    allowed.test(file.originalname.toLowerCase());
  if (isAllowed) return cb(null, true);
  cb(new Error('Only image files are allowed (jpg, png, webp)'));
};

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
    public_id: `ref_${Date.now()}_${file.originalname.replace(/\.[^.]+$/, '').replace(/\s+/g, '_')}`,
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

// ─── Multer instances ────────────────────────────────────────────────────────
// multer-storage-cloudinary streams files directly to Cloudinary.
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
  storage: profileStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
}).single('profileImage');

const uploadCover = multer({
  storage: coverStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
}).single('coverImage');

// ─── Helper: delete an image from Cloudinary by its public_id ───────────────
// Use this if you ever need to replace or remove a stored image.
// public_id is stored in req.file.filename after upload.
const deleteImage = async (publicId) => {
  if (!publicId) return;
  await cloudinary.uploader.destroy(publicId);
};

module.exports = { uploadProof, uploadReferences, uploadProfile, uploadCover, deleteImage, cloudinary };