import { describe, expect, test } from 'vitest';
import { playerSpawnYaw } from './spawn';

describe('playerSpawnYaw', () => {
  test('CTs face -z into the map, Ts face +z', () => {
    expect(playerSpawnYaw('CT')).toBe(0);
    expect(playerSpawnYaw('T')).toBe(Math.PI);
  });
});
