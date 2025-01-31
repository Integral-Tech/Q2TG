enum flags {
  DISABLE_Q2TG = 1,
  DISABLE_TG2Q = 1 << 1,
  DISABLE_JOIN_NOTICE = 1 << 2,
  DISABLE_POKE = 1 << 3,
  DISABLE_DELETE_MESSAGE = 1 << 4,
  DISABLE_AUTO_CREATE_PM = 1 << 5,
  COLOR_EMOJI_PREFIX = 1 << 6,
  // RICH_HEADER = 1 << 7,
  DISABLE_QUOTE_PIN = 1 << 8,
  DISABLE_FORWARD_OTHER_BOT = 1 << 9,
  // USE_MARKDOWN = 1 << 10,
  DISABLE_SEAMLESS = 1 << 11,
  DISABLE_FLASH_PIC = 1 << 12,
  DISABLE_SLASH_COMMAND = 1 << 13,
  DISABLE_RICH_HEADER = 1 << 14,
  DISABLE_OFFLINE_NOTICE = 1 << 15,
  HIDE_ALL_QQ_NUMBER = 1 << 16,
  NAME_LOCKED = 1 << 17,
  ALWAYS_FORWARD_TG_FILE = 1 << 18,
}

export default flags;
