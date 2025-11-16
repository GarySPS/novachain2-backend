// routes/upload.js
const express = require('express');
const multer = require('multer');
const supabase = require('../utils/supabaseClient');
const router = express.Router();

// Use multer for file upload handling
const storage = multer.memoryStorage();
const upload = multer({ storage });

// POST /api/upload/:bucket
router.post('/:bucket', upload.single('file'), async (req, res) => {
  const { bucket } = req.params;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'No file uploaded.' });

  // Unique file name: userId-timestamp-originalname
  const filename = `${Date.now()}-${file.originalname}`;

  // Upload to Supabase Storage
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(filename, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    path: data.path,
    bucket,
    url: `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${filename}`
  });
});

// GET /api/upload/:bucket/signed-url/:filename
router.get('/:bucket/signed-url/:filename', async (req, res) => {
  const { bucket, filename } = req.params;

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(filename, 60 * 60); // 1 hour expiry

  if (error) return res.status(500).json({ error: error.message });

  res.json({ url: data.signedUrl });
});

module.exports = router;
