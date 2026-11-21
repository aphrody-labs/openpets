#!/usr/bin/env bun
// aphrody-pet build <plan.json> [--out dir]: writes a validated OpenPets pet folder.
// aphrody-pet show <plan.json> [--out dir] [--hold seconds]: builds, installs into the running
// OpenPets desktop app, and holds a lease on the pet so it walks on screen.
import { join } from "node:path";
import { createOpenPetsClient } from "@open-pets/client";
import { buildPet } from "./pets.ts";

const [command, planPath, ...rest] = Bun.argv.slice(2);
const option = (name: string) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};
const outDir = option("--out") ?? join(import.meta.dir, "..", "dist");

if ((command !== "build" && command !== "show") || !planPath) {
  console.error(
    "usage: aphrody-pet build|show <plan.json> [--out dir] [--hold seconds]",
  );
  process.exit(2);
}

const built = await buildPet(planPath, outDir);
console.log(JSON.stringify(built, null, 2));

if (command === "show") {
  const client = createOpenPetsClient();
  const installed = await client.installLocalPet(built.folder, {
    kind: "folder",
  });
  console.log(JSON.stringify(installed));
  const petId = built.folder.split(/[\\/]/).at(-1);
  const { leaseId } = await client.acquireLease({ requestedPetId: petId });
  await client.say("aphrody", { reaction: "waving", leaseId });
  const holdMs = Number(option("--hold") ?? 30) * 1000;
  const heartbeat = setInterval(
    () => client.heartbeatLease(leaseId).catch(console.error),
    5000,
  );
  await Bun.sleep(holdMs);
  clearInterval(heartbeat);
  await client.releaseLease(leaseId);
}
