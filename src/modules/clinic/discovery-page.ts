// TAB-P0-03 (#694): server-fixed public discovery paging bounds. The page
// size is never chosen by the caller; the maximum page bounds the offset an
// anonymous request can ask PostgreSQL to skip.
export const PUBLIC_DISCOVERY_PAGE_SIZE = 20;
export const PUBLIC_DISCOVERY_MAX_PAGE = 500;
