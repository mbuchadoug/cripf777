// config/passport.js - CORRECTED VERSION
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import User from "../models/user.js";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import { assignOnboardingQuizzes } from "../services/onboarding.js";

export default function configurePassport() {
  passport.serializeUser((user, done) => {
    done(null, user._id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id).lean();
      done(null, user || null);
    } catch (err) {
      done(err, null);
    }
  });

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
        passReqToCallback: true
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          const isParentSignup = req.session?.signupSource === "parent";
          const isTeacherSignup = req.session?.signupSource === "private_teacher";  // ✅ ADD
          const isArenaSignup = req.session?.signupSource === "arena";             // ✅ ADD

          // Extract common fields
          const googleId = profile.id;
          const displayName = profile.displayName;
          const firstName = profile.name?.givenName || "";
          const lastName = profile.name?.familyName || "";
          const email = profile.emails?.[0]?.value?.toLowerCase() || "";
          const photo = profile.photos?.[0]?.value || "";
          const provider = profile.provider || "google";
          const locale = profile._json?.locale || "";

          // Upsert user
          const update = {
            displayName,
            firstName,
            lastName,
            email,
            photo,
            provider,
            locale,
            lastLogin: new Date(),
          };

       

          // 🔥 FORCE parent role ONLY when coming from /start
       const updateDoc = {
  $set: update,
  $setOnInsert: {
    createdAt: new Date()
    // Don't set role here yet
  }
};

// Set role based on signup source
// Set role based on signup source
// ✅ Do not flip role for existing users
if (isParentSignup) {
  updateDoc.$set.consumerEnabled = true;
  updateDoc.$set.accountType = "parent";
  updateDoc.$setOnInsert.role = "parent";
} else if (isTeacherSignup) {
  updateDoc.$set.consumerEnabled = true;
  //updateDoc.$set.accountType = "parent";
  updateDoc.$set.accountType = "private_teacher";
  updateDoc.$setOnInsert.role = "private_teacher";
} else if (isArenaSignup) {
  // ✅ Arena: allow login without forcing parent/teacher dashboards
  // make them consumerEnabled if you want arena to use consumer stuff, but DO NOT set accountType unless needed
  updateDoc.$set.consumerEnabled = true;

  // keep default employee role only if new user (or you can set a dedicated "arena" role if you want later)
  updateDoc.$setOnInsert.role = "employee";
} else {
  updateDoc.$setOnInsert.role = "employee";
}
     // 1) try by googleId first
let user = await User.findOne({ googleId });

// 2) if not found, try by email (prevents duplicates when same email exists)
if (!user && email) {
  user = await User.findOne({ email });
  if (user) {
    // attach googleId to existing email account
    user.googleId = googleId;
    // apply updates
    Object.assign(user, update);
    user.lastLogin = new Date();
    await user.save();
  }
}

// 3) if still not found, create/upsert by googleId (new user)
if (!user) {
  user = await User.findOneAndUpdate(
    { googleId },
    updateDoc,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

          // ✅ Ensure accountType is never null (prevents enum validation error)
// IMPORTANT: do NOT overwrite valid parent accounts.
// ✅ accountType is ONLY for consumer accounts (parents/guardians/student_self)
// ✅ Keep consumer flags based on flow (NOT user.role)
if (isParentSignup || isTeacherSignup) {  
  // allow employee to also be a parent
  if (!user.accountType) user.accountType = "parent";
  user.consumerEnabled = true;
} else {
  // don't destroy parent capability if they already have it
  // only disable if you truly want employees to never be parents (you do NOT)
  // so: do nothing here
}
await user.save();



// Optional: keep consumerEnabled consistent
if (user.role === "parent") {
  if (user.consumerEnabled !== true) user.consumerEnabled = true;
} else {
  // Only set this if your schema expects it; otherwise remove.
  if (user.consumerEnabled == null) user.consumerEnabled = false;
}


          // ===============================
          // 🎯 AUTO-ENROLLMENT LOGIC
          // ===============================
          
         // ===============================
// 🎯 AUTO-ENROLLMENT LOGIC (FIXED)
// Decide org membership by FLOW, not by user.role
// ===============================

const homeOrg = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
const schoolOrg = await Organization.findOne({ slug: "cripfcnt-school" }).lean();

// ✅ If they came via /auth/parent => ensure HOME membership
if ((isParentSignup || isTeacherSignup) && homeOrg) {
  const homeMembership = await OrgMembership.findOne({
    org: homeOrg._id,
    user: user._id
  });

 if (!homeMembership) {
  await OrgMembership.create({
    org: homeOrg._id,
    user: user._id,
    role: isTeacherSignup ? "private_teacher" : "parent", 
    joinedAt: new Date()
  });

  console.log(`[passport] ✅ Enrolled ${user.email} into cripfcnt-home as ${isTeacherSignup ? 'private_teacher' : 'parent'}`);
  
  // ✅ INITIALIZE AI CREDITS FOR NEW TEACHERS
// ✅ INITIALIZE TEACHER ACCOUNT (0 credits until paid)
  if (isTeacherSignup) {
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          teacherSubscriptionStatus: "trial",
          teacherSubscriptionPlan: "none",
          aiQuizCredits: 0,
          aiQuizCreditsResetAt: null,
          needsProfileSetup: true
        }
      }
    );
    console.log(`[passport] ✅ Initialized ${user.email} as teacher (0 credits, needs profile setup)`);
  }
} else {
  console.log(`[passport] ${user.email} already member of cripfcnt-home`);
}
}

// ✅ If they did NOT come via parent flow => ensure SCHOOL membership
// ✅ If they did NOT come via parent/teacher flow => ensure SCHOOL membership
if (!isParentSignup && !isTeacherSignup && schoolOrg) {
  const schoolMembership = await OrgMembership.findOne({
    org: schoolOrg._id,
    user: user._id
  });

  if (!schoolMembership) {
    await OrgMembership.create({
      org: schoolOrg._id,
      user: user._id,
      role: "employee",
      joinedAt: new Date(),
      isOnboardingComplete: false
    });

    console.log(`[passport] ✅ Enrolled ${user.email} into cripfcnt-school as employee`);

    // 🎓 Assign TRIAL quizzes for first-time users
    try {
      const { assignTrialQuizzesToUser } = await import("../services/trialQuizAssignment.js");

      const result = await assignTrialQuizzesToUser({
        userId: user._id,
        orgId: schoolOrg._id
      });

      console.log(`[passport] ✅ Assigned ${result.assigned} trial quizzes to ${user.email}`);
    } catch (err) {
      console.error("[passport] Failed to assign trial quizzes:", err.message);
    }

    // ✅ Mark employee trial fields
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          employeeSubscriptionStatus: "trial",
          employeeSubscriptionPlan: "none"
        }
      }
    );

    if (req.session) req.session.isFirstLogin = true;
  } else {
    console.log(`[passport] ${user.email} already member of cripfcnt-school`);
  }
}

// ✅ ALSO ASSIGN TRIAL QUIZZES WHEN PARENTS/TEACHERS SWITCH TO CRIPFCNT-SCHOOL
if ((isParentSignup || isTeacherSignup) && schoolOrg) {
  const schoolMembership = await OrgMembership.findOne({
    org: schoolOrg._id,
    user: user._id
  });

  // If they just joined cripfcnt-school, give them trial quizzes too
  if (!schoolMembership) {
    await OrgMembership.create({
      org: schoolOrg._id,
      user: user._id,
      role: isTeacherSignup ? "private_teacher" : "parent",
      joinedAt: new Date()
    });

    console.log(`[passport] ✅ Enrolled ${user.email} into cripfcnt-school`);

    // 🎓 Assign trial quizzes
    try {
      const { assignTrialQuizzesToUser } = await import("../services/trialQuizAssignment.js");

      const result = await assignTrialQuizzesToUser({
        userId: user._id,
        orgId: schoolOrg._id
      });

      console.log(`[passport] ✅ Assigned ${result.assigned} trial quizzes to ${user.email}`);
    } catch (err) {
      console.error("[passport] Failed to assign trial quizzes:", err.message);
    }
  }
}

          // 🧹 Clear signup source marker
          if (req.session?.signupSource) {
            delete req.session.signupSource;
          }

          return done(null, user);

        } catch (err) {
          console.error('[passport] Error:', err);
          return done(err, null);
        }
      }
    )
  );
}