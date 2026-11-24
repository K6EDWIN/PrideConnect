import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { sendAppEmail } from "@/lib/gmail";
import { logActivity } from "@/lib/audit-log";
import { buildAppUrl, escapeHtml } from "@/lib/app-url";
import { encryptFrequentFlyerEvidence } from "@/lib/frequent-flyer-verification";
import { consumeRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const ALLOWED_REGISTRATION_ROLES = [
  "ALUMNI",
  "STAFF",
  "FORMER_STAFF",
  "FREQUENT_FLYER",
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  try {
    const rateLimit = await consumeRateLimit({ request, scope: "registration-ip", limit: 10, windowMs: 60 * 60 * 1000 });
    if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfter, "Too many registration attempts. Try again later.");
    const body = await request.json().catch(() => ({}));
    const { email, password, fullName, role } = body;

    // 1. Required fields presence check
    if (!email || !password || !fullName || !role) {
      return NextResponse.json(
        { error: "email, password, fullName, and role are all required" },
        { status: 400 }
      );
    }

    // 2. Strict Role Whitelisting (Critical Security Fix)
    if (role === "ADMIN" || !ALLOWED_REGISTRATION_ROLES.includes(role)) {
      return NextResponse.json(
        {
          error:
            "Invalid role selected. Self-registration is strictly restricted to stakeholder personas (Alumni, Staff, Former Staff, Frequent Flyer).",
        },
        { status: 400 }
      );
    }

    // 3. Input Validation: Email
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!EMAIL_REGEX.test(normalizedEmail) || normalizedEmail.length > 254) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    // 4. Input Validation: Full Name
    const normalizedName = typeof fullName === "string" ? fullName.trim() : "";
    if (normalizedName.length < 2 || normalizedName.length > 100) {
      return NextResponse.json(
        { error: "Full name must be between 2 and 100 characters." },
        { status: 400 }
      );
    }

    // 5. Input Validation: Password strength
    if (typeof password !== "string" || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters long." },
        { status: 400 }
      );
    }
    if (password.length > 128) {
      return NextResponse.json(
        { error: "Password exceeds maximum allowable length of 128 characters." },
        { status: 400 }
      );
    }

    let verificationBaseUrl;
    try {
      verificationBaseUrl = buildAppUrl("/");
    } catch (error) {
      console.error("Email verification URL is not configured:", error);
      return NextResponse.json(
        { error: "Email links are not configured. Set APP_URL to the public site address and redeploy." },
        { status: 503 }
      );
    }

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      return NextResponse.json(
        { message: "If this address can be registered, verification instructions will be sent. If you already have an account, sign in or request a fresh verification link." },
        { status: 202 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const assignedDepartment =
      typeof body.department === "string" && body.department.trim()
        ? body.department.trim()
        : null;

    const assignedBio =
      typeof body.bio === "string" && body.bio.trim()
        ? body.bio.trim()
        : null;

    const assignedMentorshipRole =
      ["MENTOR", "MENTEE", "BOTH"].includes(body.mentorshipRole)
        ? body.mentorshipRole
        : null;

    let encryptedFrequentFlyerEvidence = null;
    if (role === "FREQUENT_FLYER") {
      const submittedEvidence = body.frequentFlyerEvidence || {};
      const asanteRewardsNumber = typeof submittedEvidence.asanteRewardsNumber === "string"
        ? submittedEvidence.asanteRewardsNumber.trim().toUpperCase().replace(/\s+/g, "")
        : "";
      const lastFlightNumber = typeof submittedEvidence.lastFlightNumber === "string"
        ? submittedEvidence.lastFlightNumber.trim().toUpperCase().replace(/\s+/g, " ")
        : "";
      const lastFlightDate = typeof submittedEvidence.lastFlightDate === "string"
        ? submittedEvidence.lastFlightDate.trim()
        : "";
      const lastFlightAirline = typeof submittedEvidence.lastFlightAirline === "string"
        ? submittedEvidence.lastFlightAirline.trim().toUpperCase()
        : "";
      const origin = typeof submittedEvidence.origin === "string"
        ? submittedEvidence.origin.trim().toUpperCase()
        : "";
      const destination = typeof submittedEvidence.destination === "string"
        ? submittedEvidence.destination.trim().toUpperCase()
        : "";

      if (!/^[A-Z0-9-]{4,32}$/.test(asanteRewardsNumber)) {
        return NextResponse.json({ error: "Enter a valid Asante Rewards number (4–32 letters, numbers, or hyphens)." }, { status: 400 });
      }
      if (!lastFlightAirline || lastFlightAirline.length > 60) {
        return NextResponse.json({ error: "Enter the airline for your most recent flight." }, { status: 400 });
      }
      if (!/^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?$/.test(lastFlightNumber)) {
        return NextResponse.json({ error: "Enter a valid flight number, such as KQ 102." }, { status: 400 });
      }
      if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || origin === destination) {
        return NextResponse.json({ error: "Enter different three-letter airport codes for the flight route." }, { status: 400 });
      }

      const parsedLastFlightDate = new Date(`${lastFlightDate}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lastFlightDate)
        || Number.isNaN(parsedLastFlightDate.getTime())
        || parsedLastFlightDate.toISOString().slice(0, 10) !== lastFlightDate
        || parsedLastFlightDate > new Date()
        || parsedLastFlightDate < new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000)) {
        return NextResponse.json({ error: "Enter an approximate date within the last ten years for a completed flight." }, { status: 400 });
      }

      if (submittedEvidence.consent !== true) {
        return NextResponse.json({ error: "Consent is required to send these details for administrator review." }, { status: 400 });
      }

      try {
        encryptedFrequentFlyerEvidence = encryptFrequentFlyerEvidence({
          asanteRewardsNumber,
          lastFlightAirline,
          lastFlightNumber,
          origin,
          destination,
          lastFlightDate,
        });
      } catch (error) {
        if (error?.code === "VERIFICATION_ENCRYPTION_NOT_CONFIGURED" || error?.code === "VERIFICATION_ENCRYPTION_MISCONFIGURED") {
          return NextResponse.json({ error: "Frequent Flyer record review is not configured yet. Contact the administrator before registering with this account type." }, { status: 503 });
        }
        throw error;
      }
    }

    const userData = {
      data: {
        email: normalizedEmail,
        passwordHash,
        role,
        profile: {
          create: {
            fullName: normalizedName,
            department: assignedDepartment,
            bio: assignedBio,
            mentorshipRole: assignedMentorshipRole,
            isPublic: false,
          },
        },
      },
    };
    if (encryptedFrequentFlyerEvidence) {
      userData.data.frequentFlyerVerification = {
        create: { evidenceCiphertext: encryptedFrequentFlyerEvidence },
      };
    }

    const user = await prisma.user.create({
      ...userData,
      include: { profile: true },
    });

    await logActivity({
      actorId: user.id,
      actionType: "USER_REGISTERED",
      targetId: user.id,
      summary: "Created a stakeholder account",
      details: { email: normalizedEmail, role, name: normalizedName },
    });

    // Generate a verification token valid for 24 hours
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.verificationToken.create({
      data: {
        userId: user.id,
        token,
        expiresAt,
      },
    });

    const verifyUrl = new URL("/api/auth/verify", verificationBaseUrl);
    verifyUrl.searchParams.set("token", token);
    // Security Fix: Do NOT leak sensitive verification tokens/URLs to production or server logs

    try {
      await sendAppEmail({
        to: email,
        subject: "Verify your email - Intelligent Stakeholder Matching",
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2>Welcome, ${escapeHtml(fullName)}!</h2>
            <p>Thanks for registering. Please confirm your email address to activate your account.</p>
            <p>
              <a href="${escapeHtml(verifyUrl.toString())}" style="background:#000;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;">
                Verify my email
              </a>
            </p>
            <p>Or copy this link into your browser:</p>
            <p style="word-break:break-all;color:#555;">${escapeHtml(verifyUrl.toString())}</p>
            <p>This link expires in 24 hours.</p>
          </div>
        `,
      });
    } catch (emailErr) {
      // Don't fail registration if the email fails to send -- log it so
      // you can see the issue in the terminal, but still let the user know
      // their account was created.
      console.error("Failed to send verification email:", emailErr?.code || "EMAIL_DELIVERY_ERROR");
    }

    return NextResponse.json(
      {
        message: "If this address can be registered, verification instructions will be sent. If you already have an account, sign in or request a fresh verification link.",
      },
      { status: 202 }
    );
  } catch (err) {
    console.error("Registration error:", err);
    return NextResponse.json(
      { error: "Something went wrong during registration" },
      { status: 500 }
    );
  }
}
