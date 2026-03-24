// src/handlers/auth.js
import { verifyAppleToken } from "../auth/apple.js";
import { verifyGoogleToken } from "../auth/google.js";
import { createSession, deleteSession, extractToken } from "../auth/session.js";
import { createUser, findUserByAppleId, findUserByGoogleId, findUserById, updateUser } from "../db/users.js";
import { initCredits, getCredits } from "../db/credits.js";

export async function handleAppleAuth(request, env) {
  const { identity_token, user_name } = await request.json();
  if (!identity_token) return { error: "identity_token required", status: 400 };

  const appleUser = await verifyAppleToken(identity_token, env.APPLE_CLIENT_ID);
  let user = await findUserByAppleId(env.celestia_db, appleUser.apple_user_id);
  let isNew = false;

  if (!user) {
    user = await createUser(env.celestia_db, {
      apple_user_id: appleUser.apple_user_id,
      email: appleUser.email,
      name: user_name || null,
    });
    await initCredits(env.celestia_db, user.id);
    isNew = true;
  } else if (user_name && !user.name) {
    await updateUser(env.celestia_db, user.id, { name: user_name });
    user.name = user_name;
  }

  const token = await createSession(env.NATAL_ANALYSIS_KV, user.id);
  return { data: { token, user: { id: user.id, name: user.name, email: user.email, is_new: isNew } } };
}

export async function handleGoogleAuth(request, env) {
  const { identity_token } = await request.json();
  if (!identity_token) return { error: "identity_token required", status: 400 };

  const googleUser = await verifyGoogleToken(identity_token, env.GOOGLE_CLIENT_ID);
  let user = await findUserByGoogleId(env.celestia_db, googleUser.google_user_id);
  let isNew = false;

  if (!user) {
    user = await createUser(env.celestia_db, {
      google_user_id: googleUser.google_user_id,
      email: googleUser.email,
      name: googleUser.name,
    });
    await initCredits(env.celestia_db, user.id);
    isNew = true;
  }

  const token = await createSession(env.NATAL_ANALYSIS_KV, user.id);
  return { data: { token, user: { id: user.id, name: user.name, email: user.email, is_new: isNew } } };
}

export async function handleLogout(request, env) {
  const token = extractToken(request);
  if (token) await deleteSession(env.NATAL_ANALYSIS_KV, token);
  return { data: { success: true } };
}

export async function handleGetMe(env, userId) {
  const user = await findUserById(env.celestia_db, userId);
  if (!user) return { error: "User not found", status: 404 };
  const credits = await getCredits(env.celestia_db, userId);
  return {
    data: {
      id: user.id,
      name: user.name,
      email: user.email,
      birth_date: user.birth_date,
      birth_time: user.birth_time,
      birth_place: user.birth_place,
      credits: credits?.balance || 0,
    },
  };
}

export async function handleGuestAuth(env) {
  const user = await createUser(env.celestia_db, {
    apple_user_id: null,
    google_user_id: null,
    email: null,
    name: null,
    is_guest: 1,
  });
  await initCredits(env.celestia_db, user.id);
  const token = await createSession(env.NATAL_ANALYSIS_KV, user.id);
  return { data: { token, user_id: user.id, credits: 5 } };
}

export async function handleGetCredits(env, userId) {
  const credits = await getCredits(env.celestia_db, userId);
  if (!credits) return { error: "Not found", status: 404 };
  return { data: { balance: credits.balance, daily_spent: credits.daily_spent } };
}
