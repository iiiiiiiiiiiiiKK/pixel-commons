import { describe, expect, it } from 'vitest';
import { locales, messages, reasonKeys } from '../src/lib/i18n';

/**
 * Dictionary integrity tests.
 *
 * A missing translation is invisible at runtime (the fallback silently shows English),
 * which is exactly the kind of gap nobody notices until a Chinese user reports it. These
 * tests fail the build instead.
 */

const enKeys = Object.keys(messages.en).sort();
const zhKeys = Object.keys(messages.zh).sort();

describe('i18n dictionaries', () => {
  it('has an identical key set in every language', () => {
    expect(zhKeys).toEqual(enKeys);
  });

  it('has no empty strings', () => {
    for (const [lang, dict] of Object.entries(messages)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${lang}.${key} is empty`).not.toBe('');
      }
    }
  });

  it('keeps the same {placeholders} in both languages', () => {
    const placeholders = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of enKeys as Array<keyof typeof messages.en>) {
      expect(placeholders(messages.zh[key]), `placeholders differ for ${key}`).toEqual(
        placeholders(messages.en[key]),
      );
    }
  });

  it('actually translates: most zh strings differ from en', () => {
    // Brand names and symbols are allowed to stay identical; prose must not.
    const identical = enKeys.filter(
      (key) => messages.zh[key as keyof typeof messages.zh] === messages.en[key as keyof typeof messages.en],
    );
    expect(identical.length).toBeLessThan(enKeys.length * 0.15);
  });

  it('translates every user-facing string that the UI references', () => {
    // Spot-check the keys that carry the core interaction.
    for (const key of [
      'cooldown.ready',
      'palette.title',
      'activity.title',
      'app.share',
      'app.report',
      'help.title',
      'history.title',
      'admin.title',
      'lang.switchTo',
    ] as const) {
      expect(messages.zh[key]).not.toBe(messages.en[key]);
    }
  });

  it('exposes report reason keys that exist in the dictionary', () => {
    for (const key of Object.values(reasonKeys)) {
      expect(messages.en[key]).toBeTruthy();
      expect(messages.zh[key]).toBeTruthy();
    }
  });

  it('declares a locale for each language', () => {
    expect(Object.keys(locales).sort()).toEqual(Object.keys(messages).sort());
    expect(locales.zh).toBe('zh-CN');
    expect(locales.en).toBe('en-US');
  });
});
