// DD-MM-YYYY throughout, matching the convention used across Elkay's
// other internal tools.
function formatDate(d) {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return '';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Generates the next sequential code for a table (e.g. TRIP-0001,
 * TRIP-0002...). Looks at the highest existing number with this
 * prefix and adds one - simple and readable, matching the original
 * Trip_Code / Voucher_ID / Request_ID style from the Apps Script data
 * model, rather than exposing raw database ids to users.
 */
async function nextSequentialCode(pool, table, column, prefix, padLength = 4) {
  const res = await pool.query(
    `SELECT ${column} FROM ${table} WHERE ${column} LIKE $1 ORDER BY id DESC LIMIT 1`,
    [prefix + '%']
  );
  let nextNum = 1;
  if (res.rows[0] && res.rows[0][column]) {
    const match = res.rows[0][column].match(/(\d+)$/);
    if (match) nextNum = parseInt(match[1], 10) + 1;
  }
  return prefix + String(nextNum).padStart(padLength, '0');
}

module.exports = { formatDate, nextSequentialCode };
