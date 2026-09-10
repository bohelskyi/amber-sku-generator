const express = require('express');
const { getAppConfig, createCategory, updateCategory, createQuestion, updateQuestion, createOption, updateOption, setOptionArchived, updateQuestionsOrder, deleteCatalogItem } = require('../../services/catalog.service');
const { getSchemaStatus, publishSkuSchema } = require('../../services/sku-schema.service');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { requirePermission } = require('../../auth/authorization');

const router = express.Router();

const DELETE_ITEM_PERMISSION_BY_TYPE = Object.freeze({
  category: 'catalog.manage',
  question: 'catalog.manage',
  option: 'catalog.manage',
  modifier: 'pricing.manage',
  scenario: 'pricing.manage',
});

const deleteItemPermissionMiddlewareByType = Object.freeze(
  Object.fromEntries(
    Object.entries(DELETE_ITEM_PERMISSION_BY_TYPE)
      .map(([type, permissionKey]) => [type, requirePermission(permissionKey)])
  )
);

function requireDeleteItemPermission(req, res, next) {
  const type = typeof req.body?.type === 'string' ? req.body.type : '';
  const middleware = Object.prototype.hasOwnProperty.call(
    deleteItemPermissionMiddlewareByType,
    type
  ) ? deleteItemPermissionMiddlewareByType[type] : null;
  if (!middleware) return res.status(400).json({ error: 'Invalid resource type' });
  return middleware(req, res, next);
}

Object.defineProperty(requireDeleteItemPermission, 'permissionKeys', {
  value: Object.freeze([...new Set(Object.values(DELETE_ITEM_PERMISSION_BY_TYPE))].sort()),
});

router.get('/admin/config', requirePermission('catalog.view'), async (req, res) => {
  try {
    res.json(await getAppConfig());
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/sku-schema/:catCode', requirePermission('catalog.view'), async (req, res) => {
  try {
    res.json(await getSchemaStatus(String(req.params.catCode || '').toUpperCase()));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/sku-schema/:catCode/publish', requirePermission('sku_schemas.publish'), async (req, res) => {
  try {
    res.json(await publishSkuSchema(String(req.params.catCode || '').toUpperCase(), {
      mutationContext: getRequestMutationContext(req),
    }));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/delete-item', requireDeleteItemPermission, async (req, res) => {
  try {
    const { type, id } = req.body || {};
    await deleteCatalogItem(type, id, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/category', requirePermission('catalog.manage'), async (req, res) => {
  try {
    const { code, name } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'Потрібні код і назва' });

    const result = await createCategory(req.body, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/admin/category', requirePermission('catalog.manage'), async (req, res) => {
  try {
    const { code, name } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'Потрібні код і назва' });

    const result = await updateCategory(req.body, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/question', requirePermission('catalog.manage'), async (req, res) => {
  try {
    const { key, label } = req.body || {};
    if (!key || label === undefined) {
      return res.status(400).json({ error: 'Потрібні key та назва' });
    }

    const result = await createQuestion(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/admin/question', requirePermission('catalog.manage'), async (req, res) => {
  try {
    const { id, key, label } = req.body || {};
    if (!id || !key || label === undefined) {
      return res.status(400).json({ error: 'Потрібні id, key та назва' });
    }

    const result = await updateQuestion(req.body, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/question/update', requirePermission('catalog.manage'), async (req, res) => {
  try {
    const { id, key, label } = req.body || {};
    if (!id || !key || label === undefined) {
      return res.status(400).json({ error: 'Потрібні id, key та назва' });
    }

    const result = await updateQuestion(req.body, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/admin/questions/order', requirePermission('catalog.manage'), async (req, res) => {
  try {
    const result = await updateQuestionsOrder(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/option', requirePermission('catalog.manage'), async (req, res) => {
  try {
    const result = await createOption(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/option', requirePermission('catalog.manage'), async (req, res) => {
  try {
    const { id, value_id, label } = req.body || {};
    if (!id || !label || value_id === undefined || value_id === null || value_id === '') {
      return res.status(400).json({ error: 'Потрібні id, label і value_id' });
    }

    await updateOption(req.body, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.patch('/admin/option/:id/archive', requirePermission('catalog.manage'), async (req, res) => {
  try {
    await setOptionArchived(
      {
        id: req.params.id,
        archived: req.body?.archived,
      },
      { mutationContext: getRequestMutationContext(req) }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
