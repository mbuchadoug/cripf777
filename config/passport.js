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

  // only set role if new user
  updateDoc.$setOnInsert.role = "parent";
} else {
  // only set role if new user
  updateDoc.$setOnInsert.role = "employee";
}


          const user = await User.findOneAndUpdate(
            { googleId },
            updateDoc,
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );

          // ✅ Ensure accountType is never null (prevents enum validation error)
// IMPORTANT: do NOT overwrite valid parent accounts.
// ✅ accountType is ONLY for consumer accounts (parents/guardians/student_self)
// ✅ Keep consumer flags based on flow (NOT user.role)
if (isParentSignup) {
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
if (isParentSignup && homeOrg) {
  const homeMembership = await OrgMembership.findOne({
    org: homeOrg._id,
    user: user._id
  });

  if (!homeMembership) {
    await OrgMembership.create({
      org: homeOrg._id,
      user: user._id,
      role: "parent",
      joinedAt: new Date()
    });

    console.log(`[passport] ✅ Enrolled ${user.email} into cripfcnt-home as parent`);
  } else {
    console.log(`[passport] ${user.email} already member of cripfcnt-home`);
  }
}

// ✅ If they did NOT come via parent flow => ensure SCHOOL membership
if (!isParentSignup && schoolOrg) {
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

    // 🎓 Assign TRIAL quizzes using RULES (cripfcnt-school)
    try {
      const { applyEmployeeQuizRules } = await import("../services/employeeRuleAssignment.js");

      const result = await applyEmployeeQuizRules({
        orgId: schoolOrg._id,
        userId: user._id,
        force: false
      });

      console.log(`[passport] ✅ Applied ${result.applied} employee trial rule quizzes to ${user.email}`);
    } catch (err) {
      console.error("[passport] Failed to apply employee quiz rules:", err.message);
    }

    // ✅ Mark employee trial fields ONLY (do NOT unset accountType)
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