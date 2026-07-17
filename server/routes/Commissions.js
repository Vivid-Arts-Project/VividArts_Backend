const express = require('express');
const router = express.Router();

function getCommissionStore(req) {
  if (!req.app.locals.commissionStore) {
    req.app.locals.commissionStore = [];
  }
  return req.app.locals.commissionStore;
}

router.get('/', (req, res) => {
  res.json({ success: true, commissions: getCommissionStore(req) });
});

router.post('/', (req, res) => {
  const commission = {
    id: `COM-${Date.now()}`,
    ...req.body,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };

  getCommissionStore(req).push(commission);

  res.status(201).json({ success: true, commission });
});

router.get('/:id', (req, res) => {
  const commission = getCommissionStore(req).find((item) => item.id === req.params.id);

  if (!commission) {
    return res.status(404).json({ success: false, error: 'Commission not found' });
  }

  res.json({ success: true, commission });
});

module.exports = router;
