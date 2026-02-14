import mongoose from "mongoose";

const CounterSchema = new mongoose.Schema({
  _id: String,            // e.g. "invoice", "quote", "receipt"
  seq: { type: Number, default: 0 }
});
export default mongoose.model("Counter", CounterSchema);
