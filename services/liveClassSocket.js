import { Server } from "socket.io";
import LiveClass from "../models/liveClass.js";
import User from "../models/user.js";

let io = null;

/**
 * Initialize Socket.IO for live classes
 */
export function initializeLiveClassSocket(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.SITE_URL || "http://localhost:3000",
      methods: ["GET", "POST"]
    }
  });

  io.on("connection", (socket) => {
    console.log(`[LiveClass] Client connected: ${socket.id}`);

    // Join a live class room
    socket.on("join-class", async (data) => {
      const { classId, userId, userRole } = data;
      
      try {
        const liveClass = await LiveClass.findById(classId);
        if (!liveClass) {
          socket.emit("error", { message: "Class not found" });
          return;
        }

        // Join Socket.IO room
        socket.join(`class-${classId}`);
        
        // If student joining, record attendance
        if (userRole === "student") {
          const existing = liveClass.attendees.find(
            a => String(a.studentId) === String(userId)
          );

          if (!existing) {
            liveClass.attendees.push({
              studentId: userId,
              joinedAt: new Date(),
              isPresent: true
            });
            await liveClass.save();
          }

          // Get student info
          const student = await User.findById(userId).select("firstName lastName").lean();
          
          // Notify teacher
          io.to(`class-${classId}`).emit("student-joined", {
            studentId: userId,
            studentName: `${student.firstName} ${student.lastName}`,
            joinedAt: new Date()
          });
        }

        // Send current attendance count to all participants
        const attendanceCount = liveClass.attendees.filter(a => a.isPresent).length;
        
        socket.emit("joined-class", {
          classId,
          attendanceCount,
          totalExpected: liveClass.expectedStudents.length
        });

        console.log(`[LiveClass] ${userRole} ${userId} joined class ${classId}`);

      } catch (error) {
        console.error("[LiveClass] Join error:", error);
        socket.emit("error", { message: "Failed to join class" });
      }
    });

    // Leave class
    socket.on("leave-class", async (data) => {
      const { classId, userId, userRole } = data;
      
      try {
        if (userRole === "student") {
          const liveClass = await LiveClass.findById(classId);
          if (liveClass) {
            const attendee = liveClass.attendees.find(
              a => String(a.studentId) === String(userId)
            );

            if (attendee) {
              attendee.leftAt = new Date();
              attendee.isPresent = false;
              attendee.duration = Math.round(
                (attendee.leftAt - attendee.joinedAt) / 1000
              );
              await liveClass.save();
            }

            // Notify teacher
            const student = await User.findById(userId).select("firstName lastName").lean();
            
            io.to(`class-${classId}`).emit("student-left", {
              studentId: userId,
              studentName: `${student.firstName} ${student.lastName}`,
              leftAt: new Date()
            });
          }
        }

        socket.leave(`class-${classId}`);
        console.log(`[LiveClass] ${userRole} ${userId} left class ${classId}`);

      } catch (error) {
        console.error("[LiveClass] Leave error:", error);
      }
    });

    // Request attendance update
    socket.on("get-attendance", async (data) => {
      const { classId } = data;
      
      try {
        const liveClass = await LiveClass.findById(classId)
          .populate("attendees.studentId", "firstName lastName grade")
          .lean();

        if (liveClass) {
          socket.emit("attendance-update", {
            attendees: liveClass.attendees,
            totalPresent: liveClass.attendees.filter(a => a.isPresent).length,
            totalExpected: liveClass.expectedStudents.length
          });
        }
      } catch (error) {
        console.error("[LiveClass] Attendance error:", error);
      }
    });

    socket.on("disconnect", () => {
      console.log(`[LiveClass] Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

/**
 * Get Socket.IO instance
 */
export function getIO() {
  if (!io) {
    throw new Error("Socket.IO not initialized. Call initializeLiveClassSocket first.");
  }
  return io;
}