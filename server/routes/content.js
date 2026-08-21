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

router.get('/reviews', async (_req, res) => {
  try {
    const reviews = await db.Review.findAll({
      where: { status: 'approved' },
      include: [
        { model: db.Customer, as: 'customer', attributes: ['full_name', 'username', 'profile_image_url'] },
        { model: db.Order, as: 'order', attributes: ['order_id'], include: [{ model: db.ProductOption, as: 'productOption', attributes: ['paper_size', 'num_subjects'] }] },
      ],
      order: [['createdAt', 'DESC']],
      limit: 6,
    });
    res.json(reviews.map(instance => {
      const review = instance.toJSON();
      const fullName = (review.customer?.full_name || review.customer?.username || 'Vivid customer').trim();
      const parts = fullName.split(/\s+/);
      const displayName = parts.length > 1 ? `${parts[0]} ${parts.at(-1).charAt(0)}.` : parts[0];
      return {
        id: review.review_id,
        rating: review.rating,
        title: review.title,
        comment: review.comment,
        imageUrl: review.allow_public_image ? review.image_url : null,
        customerName: displayName,
        customerAvatar: review.customer?.profile_image_url || null,
        paperSize: review.order?.productOption?.paper_size || null,
        subjects: review.order?.productOption?.num_subjects || null,
        adminReply: review.admin_reply,
        createdAt: review.createdAt,
      };
    }));
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
