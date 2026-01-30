// config/passport.js
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
      passReqToCallback: true // ✅ ADD THIS LINE
    },
     async (req, accessToken, refreshToken, profile, done) => {

        try {
          const isParentSignup = req.session?.signupSource === "start";

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

          const opts = { upsert: true, new: true, setDefaultsOnInsert: true };

const updateDoc = {
  $set: update,
  $setOnInsert: {
    createdAt: new Date()
  }
};

// 🔥 FORCE parent role ALWAYS when coming from /start
if (isParentSignup) {
  updateDoc.$set.role = "parent";
  updateDoc.$set.accountType = "parent";
  updateDoc.$set.consumerEnabled = true;

  // 🔐 critical: ensure role is never overwritten later
  updateDoc.$setOnInsert.role = "parent";
}


const user = await User.findOneAndUpdate(
  { googleId },
  updateDoc,
  opts
);


// ===============================
// 🏫 AUTO-ENROL INTO CRIPFCNT SCHOOL
// ===============================
// ❗ ONLY for NON-PARENT users

if (user.role !== "parent") {

  const ORG_SLUG = "cripfcnt-school";

  // 1️⃣ Ensure org exists
  let org = await Organization.findOne({ slug: ORG_SLUG });
  if (!org) {
    org = await Organization.create({
      name: "CRIPFCNT",
      slug: ORG_SLUG,
      type: "school"
    });
  }

  // 2️⃣ Ensure membership exists
  const existingMembership = await OrgMembership.findOne({
    org: org._id,
    user: user._id
  });

  if (!existingMembership) {
    await OrgMembership.create({
      org: org._id,
      user: user._id,
      role: "employee",
      joinedAt: new Date(),
      isOnboardingComplete: false // 🔐 REQUIRED
    });

    // 🧠 Onboarding quizzes are SCHOOL ONLY
    await assignOnboardingQuizzes({
      orgId: org._id,
      userId: user._id
    });
  }



}


// ===============================
// 🏠 ENSURE HOME ORG MEMBERSHIP FOR PARENTS
// ===============================
const HOME_ORG_SLUG = "cripfcnt-home";

const homeOrg = await Organization.findOne({ slug: HOME_ORG_SLUG });
if (!homeOrg) {
  throw new Error("Home org missing");
}

const hasHomeMembership = await OrgMembership.findOne({
  org: homeOrg._id,
  user: user._id
});

if (!hasHomeMembership) {
  await OrgMembership.create({
    org: homeOrg._id,
    user: user._id,
    role: "parent",
    joinedAt: new Date()
  });
}


// 🧹 Clear parent signup marker after use
if (req.session?.signupSource) {
  delete req.session.signupSource;
}


return done(null, user);

        } catch (err) {
          return done(err, null);
        }
      }
    )
  );
}
