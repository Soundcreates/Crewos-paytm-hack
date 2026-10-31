/** SQL access for the system domain. Business logic should call these named operations. */
export function createSystemRepository({ all, get, run }) {
  return {
    findOneSystemQuery: (...params) =>
      get(
        "SELECT 1 AS ok",
        ...params,
      ),
  };
}
