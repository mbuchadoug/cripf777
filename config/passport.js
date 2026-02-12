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
if (isParentSignup) {
  // Parent signup
  updateDoc.$set.role = "parent";
  updateDoc.$set.accountType = "parent";
  updateDoc.$set.consumerEnabled = true;
  updateDoc.$setOnInsert.role = "parent";
} else {
  // LMS signup - only for NEW users
  updateDoc.$setOnInsert.role = "employee";
}

          const user = await User.findOneAndUpdate(
            { googleId },
            updateDoc,
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );

          // ===============================
          // 🎯 AUTO-ENROLLMENT LOGIC
          // ===============================
          
          if (user.role === "parent") {
            // ✅ PARENTS → cripfcnt-home
            const homeOrg = await Organization.findOne({ slug: "cripfcnt-home" });
            if (homeOrg) {
              const exists = await OrgMembership.findOne({
                org: homeOrg._id,
                user: user._id
              });

              if (!exists) {
                await OrgMembership.create({
                  org: homeOrg._id,
                  user: user._id,
                  role: "parent",
                  joinedAt: new Date()
                });
                console.log(`[passport] Enrolled parent ${user.email} into cripfcnt-home`);
              }
            }

          } else {
            // ✅ NON-PARENTS (including /lms signups) → cripfcnt-school
            const schoolOrg = await Organization.findOne({ slug: "cripfcnt-school" });
            
            if (!schoolOrg) {
              console.error('[passport] cripfcnt-school org not found!');
              return done(null, user);
            }

            const existingMembership = await OrgMembership.findOne({
              org: schoolOrg._id,
              user: user._id
            });

            if (!existingMembership) {
              // 🆕 NEW MEMBER - Create membership
              await OrgMembership.create({
                org: schoolOrg._id,
                user: user._id,
                role: "employee",
                joinedAt: new Date(),
                isOnboardingComplete: false
              });

              console.log(`[passport] ✅ Enrolled ${user.email} into cripfcnt-school as employee`);

              // 🎓 Assign onboarding quizzes
              try {
                await assignOnboardingQuizzes({
                  orgId: schoolOrg._id,
                  userId: user._id
                });
                console.log(`[passport] ✅ Assigned onboarding quizzes to ${user.email}`);
              } catch (err) {
                console.error('[passport] Failed to assign onboarding quizzes:', err.message);
              }

              // 🚩 Mark as first login
              if (req.session) {
                req.session.isFirstLogin = true;
              }
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