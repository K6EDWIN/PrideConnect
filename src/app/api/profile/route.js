import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit-log";
import { readRequestJson } from "@/lib/request-json";

// GET: return the logged-in user's own profile, including their
// currently selected skills and interests.
export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let profile = await prisma.profile.findUnique({
    where: { userId: session.user.id },
    include: {
      skills: { include: { skill: true } },
      interests: { include: { interest: true } },
      mentorshipTopics: { select: { skillId: true, direction: true } },
    },
  });

  if (!profile) {
    profile = await prisma.profile.create({
      data: {
        userId: session.user.id,
        fullName: session.user.name || session.user.email?.split("@")[0] || "PrideConnect Member",
        department: session.user.role === "ADMIN" ? "Administration" : null,
        isPublic: false,
      },
      include: { skills: true, interests: true, mentorshipTopics: true },
    });
  }

  if (session.user.role === "ADMIN" && (profile.isPublic || profile.mentorshipRole || profile.mentorshipNeeds || profile.availability)) {
    profile = await prisma.profile.update({
      where: { id: profile.id },
      data: { isPublic: false, mentorshipRole: null, mentorshipNeeds: null, availability: null },
      include: { skills: { include: { skill: true } }, interests: { include: { interest: true } }, mentorshipTopics: true },
    });
  }

  return NextResponse.json({
    profile: {
      ...profile,
      skillIds: profile.skills.map((s) => s.skillId),
      interestIds: profile.interests.map((i) => i.interestId),
      seekingTopicIds: profile.mentorshipTopics.filter((topic) => topic.direction === "SEEKING").map((topic) => topic.skillId),
      offeringTopicIds: profile.mentorshipTopics.filter((topic) => topic.direction === "OFFERING").map((topic) => topic.skillId),
    },
  });
}

// PUT: update the logged-in user's profile fields and resync their
// skill/interest selections.
export async function PUT(request) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const parsed = await readRequestJson(request);
  if (!parsed.ok || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return NextResponse.json({ error: "Invalid JSON request body" }, { status: 400 });
  }
  const body = parsed.data;
  const allowedFields = new Set([
    "fullName", "bio", "department", "professionalBackground", "trainingHistory",
    "careerGoals", "mentorshipNeeds", "mentorshipRole", "availability", "isPublic",
    "skillIds", "interestIds", "seekingTopicIds", "offeringTopicIds",
  ]);
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return NextResponse.json({ error: "Profile update contains unsupported fields" }, { status: 400 });
  }
  const {
    fullName,
    bio,
    department,
    professionalBackground,
    trainingHistory,
    careerGoals,
    mentorshipNeeds,
    mentorshipRole,
    availability,
    isPublic,
    skillIds = [],
    interestIds = [],
    seekingTopicIds = [],
    offeringTopicIds = [],
  } = body;

  if (typeof fullName !== "string" || fullName.trim().length < 2 || fullName.trim().length > 100) {
    return NextResponse.json(
      { error: "Full name must contain between 2 and 100 characters" },
      { status: 400 }
    );
  }
  const textLimits = {
    bio: 2000,
    department: 120,
    professionalBackground: 4000,
    trainingHistory: 3000,
    careerGoals: 2000,
    mentorshipNeeds: 2000,
    availability: 500,
  };
  for (const [field, maxLength] of Object.entries(textLimits)) {
    const value = body[field];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > maxLength)) {
      return NextResponse.json({ error: `${field} must be text no longer than ${maxLength} characters` }, { status: 400 });
    }
  }
  if (body.isPublic !== undefined && typeof body.isPublic !== "boolean") {
    return NextResponse.json({ error: "isPublic must be a boolean" }, { status: 400 });
  }
  if (body.mentorshipRole !== undefined && body.mentorshipRole !== null && !["MENTOR", "MENTEE", "BOTH"].includes(body.mentorshipRole)) {
    return NextResponse.json({ error: "mentorshipRole is invalid" }, { status: 400 });
  }
  if (![skillIds, interestIds, seekingTopicIds, offeringTopicIds].every((ids) => Array.isArray(ids) && ids.length <= 100 && ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128 && !/\s/.test(id)))) {
    return NextResponse.json({ error: "Profile selections must be arrays of identifiers" }, { status: 400 });
  }

  const profile = await prisma.profile.findUnique({
    where: { userId: session.user.id },
  });

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  // Update the scalar fields, then fully resync the skill/interest join
  // tables to match whatever was just submitted (simplest correct approach
  // at this data scale -- delete old links, insert the new selection).
  const isAdmin = session.user.role === "ADMIN";
  await prisma.$transaction([
    prisma.profile.update({
      where: { id: profile.id },
      data: {
        fullName: fullName.trim(),
        bio,
        department,
        professionalBackground: isAdmin ? null : professionalBackground,
        trainingHistory: isAdmin ? null : trainingHistory,
        careerGoals: isAdmin ? null : careerGoals,
        mentorshipNeeds: isAdmin ? null : mentorshipNeeds,
        mentorshipRole: isAdmin ? null : mentorshipRole || null,
        availability: isAdmin ? null : availability,
        isPublic: isAdmin ? false : isPublic ?? true,
      },
    }),
    prisma.profileSkill.deleteMany({ where: { profileId: profile.id } }),
    prisma.profileInterest.deleteMany({ where: { profileId: profile.id } }),
    prisma.profileMentorshipTopic.deleteMany({ where: { profileId: profile.id } }),
    ...(!isAdmin && skillIds.length
      ? [
          prisma.profileSkill.createMany({
            data: skillIds.map((skillId) => ({
              profileId: profile.id,
              skillId,
            })),
          }),
        ]
      : []),
    ...(!isAdmin && interestIds.length
      ? [
          prisma.profileInterest.createMany({
            data: interestIds.map((interestId) => ({
              profileId: profile.id,
              interestId,
            })),
          }),
        ]
      : []),
    ...(!isAdmin && [...new Set([...seekingTopicIds, ...offeringTopicIds])].length
      ? [
          prisma.profileMentorshipTopic.createMany({
            data: [
              ...new Set(seekingTopicIds).map((skillId) => ({ profileId: profile.id, skillId, direction: "SEEKING" })),
              ...new Set(offeringTopicIds).map((skillId) => ({ profileId: profile.id, skillId, direction: "OFFERING" })),
            ],
          }),
        ]
      : []),
  ]);

  const updatedFields = ["fullName", "bio", "department", "isPublic"];
  if (!isAdmin) updatedFields.push("professionalBackground", "trainingHistory", "careerGoals", "mentorshipNeeds", "mentorshipRole", "availability", "skills", "interests", "mentorshipTopics");
  await logActivity({
    actorId: session.user.id,
    targetId: session.user.id,
    actionType: session.user.role === "ADMIN" ? "ADMIN_PROFILE_UPDATED" : "USER_PROFILE_UPDATED",
    summary: `${isAdmin ? "Administrator" : "Member"} updated their profile`,
    details: { fieldsUpdated: updatedFields, skillCount: isAdmin ? 0 : skillIds.length, interestCount: isAdmin ? 0 : interestIds.length },
  });

  return NextResponse.json({ message: "Profile updated" });
}
