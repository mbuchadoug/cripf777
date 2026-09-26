// services/learnerLinks.js — helpers so routers can treat linked learners like owned ones.
import LearnerLink from "../models/learnerLink.js";

export async function linkedLearnerIds(guardianId, role = null) {
  const q = { guardian: guardianId, status: "active" };
  if (role) q.role = role;
  const links = await LearnerLink.find(q).select("learner").lean();
  return links.map((l) => l.learner); // ObjectIds
}
export async function guardiansOf(learnerId, role = null) {
  const q = { learner: learnerId, status: "active" };
  if (role) q.role = role;
  return LearnerLink.find(q).select("guardian role createdAt").lean();
}
export async function isLinked(guardianId, learnerId) {
  return !!(await LearnerLink.findOne({ guardian: guardianId, learner: learnerId, status: "active" }).lean());
}
export async function linkLearner({ guardianId, learnerId, role, addedByName = "" }) {
  return LearnerLink.findOneAndUpdate(
    { guardian: guardianId, learner: learnerId },
    { $set: { role, status: "active", addedByName }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true, new: true }
  );
}
export async function unlink({ guardianId, learnerId }) {
  return LearnerLink.updateOne({ guardian: guardianId, learner: learnerId }, { $set: { status: "removed" } });
}