import Battle from "../models/battle.js";
import BattleEntry from "../models/battleEntry.js";

export async function settleBattle(battleId) {
  const battle = await Battle.findById(battleId);
  if (!battle) return { ok:false, error:"Battle not found" };

  // already settled
  if (battle.settledAt) return { ok:true, already:true };

  const now = new Date();
  if (battle.endsAt > now) return { ok:false, error:"Battle not ended yet" };

  // rank only finished
  const finished = await BattleEntry.find({ battleId, status: "finished" })
    .sort({ scorePct: -1, timeTakenSec: 1, updatedAt: 1 });

  // write ranks
  for (let i = 0; i < finished.length; i++) {
    const e = finished[i];
    e.rank = i + 1;
    await e.save();
  }

  battle.status = "ended";
  battle.settledAt = new Date();
  await battle.save();

  return { ok:true, ranked: finished.length };
}