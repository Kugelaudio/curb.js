// The agent's worker. Its boot values come first (`WorkerBoot`, from the page): the runtime
// reads them as its modules load. The page holds no key: the dev server's relay adds it.
self.onmessage = async (event) => {
  self.onmessage = null;
  const boot = event.data;
  self.__CURB_ENV__ = boot.env;
  self.__CURB_FILES__ = boot.files;
  self.__CURB_VOLUME__ = boot.volume;
  self.__CURB_PORT__ = boot.port;
  self.__CURB_QUIET__ = boot.quiet;
  await import("/runtime/worker.js");
};
