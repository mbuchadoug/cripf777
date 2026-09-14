// models/courseLesson.js
// ─────────────────────────────────────────────────────────────────────────────
// A learning-material item attached to a Course: a video (streamed from the
// existing GridFS "videos" bucket via /videos/:filename) plus a text caption,
// ordered within the course and optionally grouped under a unit title.
//
// Deliberately references a GridFS video by FILENAME (not a copy), so it reuses
// routes/videos.js upload + ranged streaming untouched. A lesson can also be
// text-only (no video) - e.g. a reading or instructions.
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from "mongoose";

const CourseLessonSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },

  title: { type: String, required: true },
  unitTitle: { type: String, default: null },   // optional: group lessons under a stage/unit

  videoFilename: { type: String, default: null }, // GridFS filename in the "videos" bucket, e.g. "intro.mp4"
  caption: { type: String, default: "" },          // notes / transcript / caption shown with the video

  order: { type: Number, default: 0 },
  published: { type: Boolean, default: true },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true });

CourseLessonSchema.index({ course: 1, order: 1 });

export default mongoose.models.CourseLesson ||
  mongoose.model("CourseLesson", CourseLessonSchema);