# Controlled Magento attribute creation

This local implementation adds two explicit Administrator actions: create a new
ordinary text/single-select product attribute, then make an exact existing attribute
available in one existing attribute set. It does not deploy anything to Magento.
Publication, option creation and product delivery remain separate reviewed steps.

## Operator flow

The category preparation workspace opens **Новий атрибут** with the exact category
context. A sole enabled approved attribute set is preselected; ambiguous routes
require an explicit choice. New attribute settings require explicit input: Ukrainian
and, when the EN store is active, English label; stable attribute code; text or
single-select type; global/website/store scope; requiredness; storefront display;
search; catalog filtering; and search-result filtering. Text filtering is unsupported.
No existing product receives a guessed value.

The review explicitly fixes the remaining bounded profile: simple products only;
no initial value/options, uniqueness, HTML/WYSIWYG, comparison, sort-by, promotion
rules, advanced-search visibility, product-list/grid features. These are a reviewed
creation profile, not silent defaults for existing attributes. Saving never edits an
existing code, changes an Amber question or publishes a schema/binding.

After **Створити атрибут у Magento**, the receipt identifies the saved attribute and
offers **Підключити до набору**. The administrator selects a live existing group and
positive order within the exact set. Already-member attributes offer the rules
handoff without any assignment POST. Verified assignment offers **Налаштувати
передачу характеристики**. New options use the existing separately attested option
workflow. Resource creation does not refresh an immutable binding observation;
continue through the existing fresh-successor review and publication.

Typed local settings survive the two local stages. Leaving with unsaved changes
requires explicit discard; browser unload warns. After a dispatched action, durable
history restores its exact identity, reviewed profile and recovery controls. Opening
the page, switching stages or opening a receipt never dispatches an action.

## API and persistence

Under `/api/admin/magento-integration/attributes`:

| Route | Meaning |
| --- | --- |
| GET `context` | Draft-bound existing sets, live selected-set groups/members and active EN store. Bounded remote GETs only. |
| POST `preview` | Exact new attribute profile and code-absence review. No remote writes. |
| POST `apply` | Explicit reviewed create using stock no-ID attribute POST. |
| POST `assignment-preview` | Exact attribute metadata and absence from the selected set; reviewed group/order. |
| POST `assignment-apply` | Explicit single additive membership operation. |
| POST `reconcile` | GET-only recovery of the exact original action. |

All routes require effective `export_templates.manage` and
`export_templates.publish` plus the actual immutable Administrator role. Existing
authentication, active-user and CSRF boundaries apply. The service checks the role
again inside every ledger mutation, not just in React. Draft origin, state and
revision are checked before sealing and at dispatch. Preview changes require a new
review; no arbitrary URL/body/method proxy is exposed.

Migration `059_magento_attribute_actions.sql` only extends the existing permanent
configuration ledger's kind allowlist with `attribute` and `attribute_assignment`.
It changes no existing intent, attestation, reservation, transition, permission or
publication. Origin/resource uniqueness and the access lock serialize independent
Amber callers; sealed/dispatched/returned/verified evidence remains immutable.
Remote I/O runs outside business transactions and locks. A sealed action may be
replaced only by the existing explicitly reviewed undispatched-successor flow.

Creation persists the exact returned attribute ID before GET verification of code,
type, labels, scope, requiredness, source/backend type, all reviewed flags and empty
options/default. A lost CREATE response without a durable returned ID stays
uncertain: a matching code/label cannot prove attribution or authorize another POST.

Assignment targets an already-known attribute ID/code and exact set. The durable
receipt's `remoteId` denotes that attribute ID, **not** Magento's entity-association
ID. After a lost response, GET-only recovery can verify the exact desired membership
and unchanged attribute metadata. No retry/reassignment, unassign, move, delete,
attribute-set creation or generic attribute editor is provided.

## Stock Magento assignment boundary

Magento's stock assignment endpoint sets the selected group and sort order by
deleting/reinserting that attribute's association in the target set. The preview
therefore explicitly authorizes that placement. Amber refuses a membership that
already exists at review or at its repeated pre-dispatch check; it never presents
this as a tool to move/reorder an existing association.

Those GET checks are point-in-time evidence. Stock REST supplies no remote CAS:
an independent Magento administrator could add the same membership between the
last GET and the POST. The reviewed POST can then set the selected group/order.
The UI must not promise preservation of a concurrently created placement.

The stock set-attributes read verifies availability of the exact attribute in the
set, but does not expose association ID, group or order through its declared
attribute interface. Receipts therefore report **membership verified** and
`assignmentPlacementVerified: false`; they never claim verified group/order or
ownership of another actor's association. Exact placement/CAS management would
require a separate Magento-side contract. Other observed members must remain
present during verification, and uncertain membership is never resent.

Primary source contracts inspected for Magento 2.4.6:
[REST routes](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/etc/webapi.xml),
[attribute repository create branch](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/Model/Product/Attribute/Repository.php),
[assignment implementation](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Eav/Model/AttributeManagement.php),
[association persistence](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Eav/Model/ResourceModel/Entity/Attribute.php),
[attribute read interface](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Eav/Api/Data/AttributeInterface.php).

## Verification

`magento-attribute-create.test.js` covers the closed profile, exact read verification,
bounded metadata and typed signer. `33-magento-attributes.cases.js` uses only fake
Magento and disposable PostgreSQL for independent-connection create races, permanent
evidence, lost create/assignment responses, Administrator authority, revision drift
and migration-058 upgrade/rollback/repeat startup. Client regressions cover explicit
settings, no implicit dispatch, dirty navigation, exact set context, already-member
handoff, capability gating and original-action recovery after reload.
