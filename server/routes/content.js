const express = require('express');
const router = express.Router();
const db = require('../models');
const { uploadGallery, deleteImage } = require('../middleware/upload');

const requireAdmin = (req, res, next) => req.session?.adminId
  ? next()
  : res.status(401).json({ error: 'Unauthorized' });

router.get('/gallery', async (_req, res) => {
  try {
    const images = await db.GalleryImage.findAll({
      where: { isActive: true }, order: [['sortOrder', 'ASC'], ['id', 'ASC']],
    });
    res.json(images);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/admin/gallery', requireAdmin, async (_req, res) => {
  try { res.json(await db.GalleryImage.findAll({ order: [['sortOrder', 'ASC'], ['id', 'ASC']] })); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/admin/gallery', requireAdmin, (req, res) => uploadGallery(req, res, async (error) => {
  if (error) return res.status(400).json({ error: error.message });
  if (!req.file) return res.status(400).json({ error: 'Please select an image' });
  try {
    const image = await db.GalleryImage.create({
      placement: req.body.placement === 'home' ? 'home' : 'gallery',
      title: String(req.body.title || '').trim() || 'Portrait', subtitle: req.body.subtitle || null,
      altText: req.body.altText || req.body.title || 'Vivid Arts portrait',
      sortOrder: Number(req.body.sortOrder) || 0, imageUrl: req.file.path, publicId: req.file.filename,
    });
    res.status(201).json(image);
  } catch (e) { await deleteImage(req.file.filename).catch(() => {}); res.status(500).json({ error: e.message }); }
}));

router.patch('/admin/gallery/:id', requireAdmin, (req, res) => uploadGallery(req, res, async (error) => {
  if (error) return res.status(400).json({ error: error.message });
  try {
    const image = await db.GalleryImage.findByPk(req.params.id);
    if (!image) { if (req.file) await deleteImage(req.file.filename).catch(() => {}); return res.status(404).json({ error: 'Image not found' }); }
    const oldPublicId = image.publicId;
    const updates = {};
    for (const key of ['title', 'subtitle', 'altText']) if (req.body[key] !== undefined) updates[key] = req.body[key];
    if (req.body.placement !== undefined) updates.placement = req.body.placement === 'home' ? 'home' : 'gallery';
    if (req.body.sortOrder !== undefined) updates.sortOrder = Number(req.body.sortOrder) || 0;
    if (req.body.isActive !== undefined) updates.isActive = String(req.body.isActive) === 'true';
    if (req.file) { updates.imageUrl = req.file.path; updates.publicId = req.file.filename; }
    await image.update(updates);
    if (req.file && oldPublicId) await deleteImage(oldPublicId).catch(() => {});
    res.json(image);
  } catch (e) { res.status(500).json({ error: e.message }); }
}));

router.delete('/admin/gallery/:id', requireAdmin, async (req, res) => {
  try {
    const image = await db.GalleryImage.findByPk(req.params.id);
    if (!image) return res.status(404).json({ error: 'Image not found' });
    const publicId = image.publicId; await image.destroy();
    await deleteImage(publicId).catch(() => {});
    res.json({ message: 'Image removed' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
