export function createNavigationCoordinator() {
  let currentIntent = 0;

  return {
    begin() {
      currentIntent += 1;
      return currentIntent;
    },

    isCurrent(intentId) {
      return intentId === currentIntent;
    },

    current() {
      return currentIntent;
    },

    async run({ flush, load, commit }) {
      const intentId = this.begin();
      await flush();
      if (!this.isCurrent(intentId)) return null;

      const result = await load();
      if (!this.isCurrent(intentId)) return null;

      commit(result);
      return result;
    },
  };
}
