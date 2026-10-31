import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../utils/errors.mjs';

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new HttpError(400, 'Password must be between 12 and 256 characters.');
  }

  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

export function passwordMatches(password, salt, expected) {
  const actual = scryptSync(password, salt, 64);
  const other = Buffer.from(expected, 'hex');
  return actual.length === other.length && timingSafeEqual(actual, other);
}
