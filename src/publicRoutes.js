const express = require('express');
const router = express.Router();

// Placeholder - the actual Doer-facing endpoints (list Doers for the
// dropdown, start a trip, add a voucher, submit a trip, request an
// advance) get built here in the next stage.
router.get('/ping', (req, res) => res.json({ ok: true }));

module.exports = { router };
