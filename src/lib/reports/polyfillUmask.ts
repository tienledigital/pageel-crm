if (typeof process !== 'undefined') {
  try {
    Object.defineProperty(process, 'umask', {
      value: () => 0o022,
      writable: true,
      configurable: true,
    });
  } catch (e) {
    try {
      (process as any).umask = () => 0o022;
    } catch (err) {
      // Ignore if completely frozen
    }
  }
}
