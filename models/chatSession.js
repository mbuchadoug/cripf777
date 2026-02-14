// models/chatSession.js
const ChatSessionSchema = new mongoose.Schema({
  providerId: String,
  state: String,
  data: Object,
  updatedAt: Date,
});
