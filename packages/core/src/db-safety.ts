// Extracted as a pure function so the test-database safety rule itself has a
// unit test, independent of the script that shells out to the Prisma CLI.
export function extractDatabaseName(connectionUrl: string): string {
  return new URL(connectionUrl).pathname.replace(/^\//, "");
}

export function isTestDatabaseName(databaseName: string): boolean {
  return databaseName.toLowerCase().includes("test");
}
