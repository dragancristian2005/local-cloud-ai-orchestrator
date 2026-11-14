// The arithmetic mean of a list of numbers.
export function average(values) {
  const sum = values.reduce((total, value) => total + value, 0);
  return sum / values.length;
}
