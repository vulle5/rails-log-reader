/**
 * The `default` of a switch that handles every member of a union. Its argument is `never` there,
 * so a member added to the union and left unhandled is a type error at the switch.
 */
export function unreachable(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`)
}
