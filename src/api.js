const express = require('express');
const { requireLogin } = require('./auth');
const router = express.Router();

router.use(requireLogin); // everything below this line requires Admin/Accounts login

// Placeholder - the actual dashboard endpoints (list all trips, decide
// advances, pass/reject trips, manage Doers, export PDF) get built here
// in the next stage.
router.get('/ping', (req, res) => res.json({ ok: true }));

module.exports = router;
