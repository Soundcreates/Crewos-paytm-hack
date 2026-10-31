import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';

export function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function cleanString(value, name, max = 500, min = 1) {
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be text.`);

  const clean = value.trim();
  if (clean.length < min || clean.length > max) {
    throw new HttpError(400, `${name} must be between ${min} and ${max} characters.`);
  }

  return clean;
}

export function optionalTimestamp(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, `${name} must be a valid date and time.`);
  }

  return new Date(value).toISOString();
}

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }

  return email;
}

export function isDuplicateSignupEmail(error) {
  if (error?.code === '23505' && (error.constraint === 'users_email_key' || (error.table === 'users' && error.column === 'email'))) {
    return true;
  }

  return /UNIQUE constraint failed: users\.email$/i.test(String(error?.message || ''));
}

export function validateOrgName(value) {
  return cleanString(value, 'Organization name', 100);
}
