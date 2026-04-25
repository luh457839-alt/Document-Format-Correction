export function detectTemplateNumberingPrefix(text: string): string | undefined {
  const hierarchicalNumericPrefix = detectHierarchicalNumericPrefix(text);
  if (hierarchicalNumericPrefix) {
    return hierarchicalNumericPrefix;
  }

  const singleLevelNumericPrefix = detectSingleLevelNumericPrefix(text);
  if (singleLevelNumericPrefix) {
    return singleLevelNumericPrefix;
  }

  const patterns = [
    /^\s*([一二三四五六七八九十]+[、.)．])/,
    /^\s*([（(][一二三四五六七八九十\d]+[）)])/,
    /^\s*([A-Za-z][.)])/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function detectHierarchicalNumericPrefix(text: string): string | undefined {
  const match = text.match(/^\s*([1-9]\d*(?:\.\d{1,2})+)/);
  if (!match?.[1]) {
    return undefined;
  }

  const prefix = match[1];
  const remainder = text.slice(match[0].length);
  if (!remainder) {
    return undefined;
  }
  const delimiterMatch = remainder.match(/^([)）、．。、])/);
  if (delimiterMatch?.[1]) {
    return `${prefix}${delimiterMatch[1]}`;
  }
  if (/^\s+\S/.test(remainder)) {
    return prefix;
  }
  if (/^[A-Za-z\u4E00-\u9FFF（(]/.test(remainder)) {
    return prefix;
  }
  return undefined;
}

function detectSingleLevelNumericPrefix(text: string): string | undefined {
  const match = text.match(/^\s*(\d+[.)、．])/);
  if (!match?.[1]) {
    return undefined;
  }

  const remainder = text.slice(match[0].length);
  if (/^\s+\S/.test(remainder)) {
    return match[1];
  }
  if (/^[A-Za-z\u4E00-\u9FFF（(]/.test(remainder)) {
    return match[1];
  }
  return undefined;
}
