import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { callsBy } from "./contacts";
import { assertDashboardKey } from "./lib/auth";

/**
 * A profile for each person in the owner's life, with two sides kept apart:
 *
 *   - What the owner tells Perry about them (people.about): "Datta is my gym
 *     buddy", "Arjun's birthday is 14 October". Kept by Perry from the owner's
 *     chats (update_person), and sent with any of the owner's messages that
 *     name them, so "what should I get Arjun?" knows who Arjun is. Never in a
 *     chat with anyone else: not with them, not with anyone.
 *   - What they tell Perry about themselves, in their own chat
 *     (contacts.profile, update_profile): their name, what they like, what
 *     they are after. Sent only to chats with them, as the owner's USER.md is
 *     to the owner's; in the owner's chats only when the owner asks
 *     (read_person), and marked as their word.
 *
 * The brief (contacts.brief) stays the one way anything of the owner's
 * reaches them.
 */

type Person = Doc<"people">;

/**
 * The one person and the one contact that go by the same name, linked, so
 * their profile shows both sides: whichever came first, the owner telling
 * Perry about Datta, or Datta writing. With two of either, nothing is guessed.
 */
export async function linkByName(ctx: MutationCtx, name: string) {
  const wanted = name.trim().toLowerCase();
  const people = (await ctx.db.query("people").collect()).filter((person) => names(person).some((known) => known.trim().toLowerCase() === wanted));
  const contacts = (await ctx.db.query("contacts").collect()).filter((contact) => contact.kind === "person" && contact.status !== "known" && contact.name.trim().toLowerCase() === wanted);
  if (people.length !== 1 || contacts.length !== 1 || people[0].contactId) return;
  const linked = await ctx.db.query("people").withIndex("by_contact", (q) => q.eq("contactId", contacts[0]._id)).first();
  if (!linked) await ctx.db.patch(people[0]._id, { contactId: contacts[0]._id });
}

const names = (person: Person) => [person.name, ...(person.aliases ?? [])];

async function byName(ctx: QueryCtx, name: string): Promise<Person | null> {
  const wanted = name.trim().toLowerCase();
  const all = await ctx.db.query("people").collect();
  return all.find((person) => names(person).some((known) => known.trim().toLowerCase() === wanted)) ?? null;
}

/**
 * The owner's message names these people: their profiles, whole, for the
 * turn; and everyone else only by name, so Perry knows whom it knows.
 */
export const forMessage = internalQuery({
  args: { text: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const all = await ctx.db.query("people").collect();
    if (!all.length) return "";
    const named = args.text.trim() ? all.filter((person) => names(person).some((name) => callsBy(name, args.text))) : [];
    const others = all.filter((person) => !named.includes(person)).map((person) => person.name);
    return [
      named.length ? `# People in this message, as the owner has told you about them\n\n${named.map((person) => `## ${person.name}${person.aliases?.length ? ` (${person.aliases.join(", ")})` : ""}\n\n${person.about}`).join("\n\n")}` : "",
      others.length ? `# Other people you have a profile for\n\n${others.join(", ")}. read_person has what the owner told you about any of them.` : "",
    ].filter(Boolean).join("\n\n");
  },
});

/** What the owner told Perry about someone, as a whole document: made, or replaced. */
export const save = internalMutation({
  args: { name: v.string(), about: v.string(), aliases: v.optional(v.array(v.string())), contactId: v.optional(v.string()) },
  returns: v.object({ id: v.id("people"), created: v.boolean() }),
  handler: async (ctx, args) => {
    const contactId = args.contactId ? ctx.db.normalizeId("contacts", args.contactId) ?? undefined : undefined;
    const now = Date.now();
    const aliases = args.aliases?.map((alias) => alias.trim()).filter(Boolean);
    const existing = await byName(ctx, args.name) ?? (contactId ? await ctx.db.query("people").withIndex("by_contact", (q) => q.eq("contactId", contactId)).first() : null);
    if (existing) {
      await ctx.db.patch(existing._id, {
        about: args.about.trim(),
        ...(aliases?.length ? { aliases: [...new Set([...(existing.aliases ?? []), ...aliases])] } : {}),
        ...(contactId ? { contactId } : {}),
        updatedAt: now,
      });
      if (!contactId) await linkByName(ctx, existing.name);
      return { id: existing._id, created: false };
    }
    const id = await ctx.db.insert("people", {
      name: args.name.trim(), about: args.about.trim(), ...(aliases?.length ? { aliases } : {}), ...(contactId ? { contactId } : {}), createdAt: now, updatedAt: now,
    });
    if (!contactId) await linkByName(ctx, args.name);
    return { id, created: true };
  },
});

/** Everything Perry knows of someone, for the owner: what the owner said, and what they said themselves, marked as theirs. */
export const read = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args): Promise<{ name: string; aboutFromOwner?: string; theySaid?: string; contact?: { id: Id<"contacts">; channel: string; handle?: string; status: string } } | { error: string }> => {
    let person = await byName(ctx, args.name);
    // Someone Perry talks with but the owner has said nothing about yet.
    const contacts = await ctx.db.query("contacts").collect();
    const contact = person?.contactId ? await ctx.db.get(person.contactId)
      : contacts.find((item) => item.name.trim().toLowerCase() === args.name.trim().toLowerCase()) ?? null;
    if (!person && contact) person = await ctx.db.query("people").withIndex("by_contact", (q) => q.eq("contactId", contact._id)).first();
    if (!person && !contact) return { error: `No profile for ${args.name}.` };
    return {
      name: person?.name ?? contact!.name,
      ...(person ? { aboutFromOwner: person.about } : {}),
      ...(contact?.profile ? { theySaid: contact.profile } : {}),
      ...(contact ? { contact: { id: contact._id, channel: contact.channel, handle: contact.handle, status: contact.status } } : {}),
    };
  },
});

// --- Settings → People -------------------------------------------------------------------------

export type PersonView = { id: Id<"people">; name: string; aliases?: string[]; about: string; contactId?: Id<"contacts">; updatedAt: number };

export const listForDashboard = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<PersonView[]> => {
    assertDashboardKey(args.key);
    return (await ctx.db.query("people").collect())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((person) => ({ id: person._id, name: person.name, aliases: person.aliases, about: person.about, contactId: person.contactId, updatedAt: person.updatedAt }));
  },
});

/** The owner's side of someone's profile, as the owner writes it: by the person, or by the contact it belongs to. */
export const setAbout = mutation({
  args: { key: v.string(), id: v.optional(v.id("people")), contactId: v.optional(v.id("contacts")), about: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const now = Date.now();
    const person = args.id ? await ctx.db.get(args.id)
      : args.contactId ? await ctx.db.query("people").withIndex("by_contact", (q) => q.eq("contactId", args.contactId)).first() : null;
    if (person) {
      await ctx.db.patch(person._id, { about: args.about.trim(), updatedAt: now });
      return null;
    }
    const contact = args.contactId ? await ctx.db.get(args.contactId) : null;
    if (!contact || !args.about.trim()) return null;
    await ctx.db.insert("people", { name: contact.name, about: args.about.trim(), contactId: contact._id, createdAt: now, updatedAt: now });
    return null;
  },
});

export const remove = mutation({
  args: { key: v.string(), id: v.id("people") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    if (await ctx.db.get(args.id)) await ctx.db.delete(args.id);
    return null;
  },
});
