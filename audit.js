// Shared by the admin portal and the label designer: loads the signed-in admin and
// performs "audited" writes (every change gets a changelog entry in the same batch).
import { db, F } from "./fb.js";

export async function loadAdmin(user) {
  try {
    const snap = await F.getDoc(F.doc(db, "admins", user.uid));
    if (!snap.exists() || snap.data().active !== true) return null;
    return { uid: user.uid, email: user.email, name: snap.data().name || user.email };
  } catch (e) {
    console.error(e);
    return null;
  }
}

/**
 * ops: [{ ref?, mode:'set'|'update', data, audit?:{action,targetType,targetId,summary,before,after} }]
 * Each op with `audit` gets a changelog entry written in the SAME batch, and its target
 * document is stamped with that entry's id. The database rules refuse admin writes that
 * don't carry a matching entry, so nothing changes without a footprint.
 */
export async function commitAudited(me, ops, batchId = null) {
  const batch = F.writeBatch(db);
  for (const op of ops) {
    let payload = op.data;
    if (op.audit) {
      const aref = F.doc(F.collection(db, "auditLog"));
      batch.set(aref, {
        adminUid: me.uid, adminEmail: me.email, adminName: me.name,
        action: op.audit.action, targetType: op.audit.targetType, targetId: op.audit.targetId,
        summary: op.audit.summary, before: op.audit.before ?? null, after: op.audit.after ?? null,
        batchId, ts: F.serverTimestamp(),
      });
      payload = { ...payload, auditId: aref.id };
    }
    if (!op.ref) continue; // audit-only entry (e.g. sign-in)
    if (op.mode === "update") batch.update(op.ref, payload);
    else batch.set(op.ref, payload);
  }
  await batch.commit();
}
