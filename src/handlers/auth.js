// src/handlers/auth.js
import { verifyAppleToken } from "../auth/apple.js";
import { verifyGoogleToken } from "../auth/google.js";
import { createSession, deleteSession, extractToken } from "../auth/session.js";
import { createUser, findUserByAppleId, findUserByGoogleId, findUserById, updateUser, upgradeGuestUser, scheduleDeleteUser, cancelDeleteUser, deleteUserCompletely } from "../db/users.js";
import { initCredits, getCredits } from "../db/credits.js";
import { validateSession } from "../auth/session.js";

async function resolveCurrentUser(request, env) {
  const token = extractToken(request);
  if (!token) return null;
  const userId = await validateSession(env.NATAL_ANALYSIS_KV, token);
  if (!userId) return null;
  return findUserById(env.celestia_db, userId);
}

function extractProfileUpdate(body) {
  const update = {};
  if (typeof body.birth_date === 'string') update.birth_date = body.birth_date;
  if (typeof body.birth_time === 'string') update.birth_time = body.birth_time;
  if (typeof body.birth_place === 'string') update.birth_place = body.birth_place;
  if (typeof body.latitude === 'number') update.latitude = body.latitude;
  if (typeof body.longitude === 'number') update.longitude = body.longitude;
  return update;
}

export async function handleAppleAuth(request, env) {
  const cloned = request.clone();
  const body = await cloned.json();
  const { identity_token, user_name } = body;
  if (!identity_token) return { error: "identity_token required", status: 400 };

  const appleUser = await verifyAppleToken(identity_token, env.APPLE_CLIENT_ID);
  let existingAccount = await findUserByAppleId(env.celestia_db, appleUser.apple_user_id);
  let user;
  let isNew = false;

  if (existingAccount) {
    // Returning user — log them in
    user = existingAccount;
    if (user_name && !user.name) {
      await updateUser(env.celestia_db, user.id, { name: user_name });
      user.name = user_name;
    }
    if (user.delete_scheduled_at) {
      await cancelDeleteUser(env.celestia_db, user.id);
    }
    // If current session is a guest, delete that orphan guest account
    const currentUser = await resolveCurrentUser(request, env);
    if (currentUser && currentUser.is_guest && currentUser.id !== user.id) {
      await deleteUserCompletely(env.celestia_db, currentUser.id);
    }
  } else {
    // No account with this Apple ID — check if current session is a guest
    const currentUser = await resolveCurrentUser(request, env);

    if (currentUser && currentUser.is_guest && !currentUser.apple_user_id) {
      // Upgrade guest to Apple account
      await upgradeGuestUser(env.celestia_db, currentUser.id, {
        apple_user_id: appleUser.apple_user_id,
        email: appleUser.email,
        name: user_name || null,
      });
      user = { ...currentUser, apple_user_id: appleUser.apple_user_id, email: appleUser.email || currentUser.email, name: user_name || currentUser.name };
    } else {
      // Brand new user
      user = await createUser(env.celestia_db, {
        apple_user_id: appleUser.apple_user_id,
        email: appleUser.email,
        name: user_name || null,
      });
      await initCredits(env.celestia_db, user.id);
      isNew = true;
    }
  }

  const profileUpdate = extractProfileUpdate(body);
  if (Object.keys(profileUpdate).length) {
    await updateUser(env.celestia_db, user.id, profileUpdate);
  }

  const token = await createSession(env.NATAL_ANALYSIS_KV, user.id);
  return { data: { token, user: { id: user.id, name: user.name, email: user.email, is_new: isNew } } };
}

export async function handleGoogleAuth(request, env) {
  const cloned = request.clone();
  const body = await cloned.json();
  const { identity_token } = body;
  if (!identity_token) return { error: "identity_token required", status: 400 };

  const googleUser = await verifyGoogleToken(identity_token, env.GOOGLE_CLIENT_ID);
  let existingAccount = await findUserByGoogleId(env.celestia_db, googleUser.google_user_id);
  let user;
  let isNew = false;

  if (existingAccount) {
    // Returning user — log them in
    user = existingAccount;
    if (user.delete_scheduled_at) {
      await cancelDeleteUser(env.celestia_db, user.id);
    }
    // If current session is a guest, delete that orphan guest account
    const currentUser = await resolveCurrentUser(request, env);
    if (currentUser && currentUser.is_guest && currentUser.id !== user.id) {
      await deleteUserCompletely(env.celestia_db, currentUser.id);
    }
  } else {
    // No account with this Google ID — check if current session is a guest
    const currentUser = await resolveCurrentUser(request, env);

    if (currentUser && currentUser.is_guest && !currentUser.google_user_id) {
      // Upgrade guest to Google account
      await upgradeGuestUser(env.celestia_db, currentUser.id, {
        google_user_id: googleUser.google_user_id,
        email: googleUser.email,
        name: googleUser.name,
      });
      user = { ...currentUser, google_user_id: googleUser.google_user_id, email: googleUser.email || currentUser.email, name: googleUser.name || currentUser.name };
    } else {
      // Brand new user
      user = await createUser(env.celestia_db, {
        google_user_id: googleUser.google_user_id,
        email: googleUser.email,
        name: googleUser.name,
      });
      await initCredits(env.celestia_db, user.id);
      isNew = true;
    }
  }

  const profileUpdate = extractProfileUpdate(body);
  if (Object.keys(profileUpdate).length) {
    await updateUser(env.celestia_db, user.id, profileUpdate);
  }

  const token = await createSession(env.NATAL_ANALYSIS_KV, user.id);
  return { data: { token, user: { id: user.id, name: user.name, email: user.email, is_new: isNew } } };
}

export async function handleLogout(request, env) {
  const token = extractToken(request);
  if (token) await deleteSession(env.NATAL_ANALYSIS_KV, token);
  return { data: { success: true } };
}

export async function handleUpdateMe(request, env, userId) {
  let body = {};
  try { body = await request.json(); } catch (_) {}

  const update = {};
  if (typeof body.name === 'string' && body.name.trim()) update.name = body.name.trim();
  if (typeof body.birth_date === 'string') update.birth_date = body.birth_date;
  if (typeof body.birth_time === 'string') update.birth_time = body.birth_time;
  if (typeof body.birth_place === 'string') update.birth_place = body.birth_place;
  if (typeof body.latitude === 'number') update.latitude = body.latitude;
  if (typeof body.longitude === 'number') update.longitude = body.longitude;

  if (!Object.keys(update).length) return { error: 'No updatable fields provided', status: 400 };

  await updateUser(env.celestia_db, userId, update);
  const user = await findUserById(env.celestia_db, userId);
  return {
    data: {
      id: user.id,
      name: user.name,
      email: user.email,
      birth_date: user.birth_date,
      birth_time: user.birth_time,
      birth_place: user.birth_place,
      latitude: user.latitude,
      longitude: user.longitude,
    },
  };
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

export async function handleGuestAuth(request, env) {
  let body = {};
  try { body = await request.json(); } catch (_) {}

  const user = await createUser(env.celestia_db, {
    apple_user_id: null,
    google_user_id: null,
    email: null,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null,
    is_guest: 1,
  });
  await initCredits(env.celestia_db, user.id);

  const profileUpdate = {};
  if (typeof body.birth_date === 'string') profileUpdate.birth_date = body.birth_date;
  if (typeof body.birth_time === 'string') profileUpdate.birth_time = body.birth_time;
  if (typeof body.birth_place === 'string') profileUpdate.birth_place = body.birth_place;
  if (typeof body.latitude === 'number') profileUpdate.latitude = body.latitude;
  if (typeof body.longitude === 'number') profileUpdate.longitude = body.longitude;
  if (Object.keys(profileUpdate).length) {
    await updateUser(env.celestia_db, user.id, profileUpdate);
  }

  const token = await createSession(env.NATAL_ANALYSIS_KV, user.id);
  return { data: { token, user_id: user.id, credits: 5 } };
}

export async function handleGetCredits(env, userId) {
  const credits = await getCredits(env.celestia_db, userId);
  if (!credits) return { error: "Not found", status: 404 };
  return { data: { balance: credits.balance, daily_spent: credits.daily_spent } };
}

export async function handleDeleteAccount(request, env, userId) {
  const user = await findUserById(env.celestia_db, userId);
  if (!user) return { error: "User not found", status: 404 };

  if (user.delete_scheduled_at) {
    return { data: { message: "Account is already scheduled for deletion", delete_scheduled_at: user.delete_scheduled_at } };
  }

  const deleteAt = await scheduleDeleteUser(env.celestia_db, userId);

  // Invalidate current session
  const token = extractToken(request);
  if (token) await deleteSession(env.NATAL_ANALYSIS_KV, token);

  return { data: { message: "Account scheduled for deletion", delete_scheduled_at: deleteAt } };
}
