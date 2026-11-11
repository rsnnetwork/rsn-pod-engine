// client/src/features/reason/entities/entity-api.ts
// Everything the Entities pages read and write: the routes of the entities contract (Task 10, 21 Oct 2026).
import api from '@/lib/api';
import type {
  CreateEntityResult, EntityList, EntityMembershipResult, EntityPage, EntityRole, EntityService, LeaveEntityResult,
  PersonEntity, PictureCrop, PictureSource, SetEntityServicesBody,
} from '@rsn/shared';
import type { EntityChanges, NewEntityBody } from './entity-form';

// Under the REASON root, so everything REASON caches can be refreshed together; `all` refreshes every entity screen.
export const entityKeys = {
  all: ['reason', 'entities'] as const,
  list: (term: string) => ['reason', 'entities', 'list', term] as const,
  page: (id: string) => ['reason', 'entities', 'page', id] as const,
  person: (userId: string) => ['reason', 'entities', 'person', userId] as const,
};

// An id is one encoded segment of an address. A route parameter arrives decoded, so a crafted one would otherwise be
// read as another route.
const entitySegment = (id: string) => encodeURIComponent(id);

/** A person's own entities, with their role and title in each. Your own id gives yours (Your profile). */
export const fetchPersonEntities = (userId: string) =>
  api.get(`/users/${entitySegment(userId)}/entities`).then((r) => r.data.data as PersonEntity[]);

/** Your entities, and others: a name search from 2 characters (searchTerm), else the most recently active. */
export const fetchEntities = (term: string) =>
  api.get('/entities', { params: term ? { q: term } : {} }).then((r) => r.data.data as EntityList);

export const fetchEntity = (id: string) => api.get(`/entities/${entitySegment(id)}`).then((r) => r.data.data as EntityPage);

export const createEntity = (body: NewEntityBody) => api.post('/entities', body).then((r) => r.data.data as CreateEntityResult);

export const updateEntity = (id: string, changes: EntityChanges) => api.patch(`/entities/${entitySegment(id)}`, changes);

/** Archive: its admins and platform admins only. Every link is kept; the page closes and the name is free again. */
export const archiveEntity = (id: string) => api.delete(`/entities/${entitySegment(id)}`);

/**
 * Ask to join with a role, or ask to change your own role (30 Oct review: both wait for the entity's admins, unless
 * you are one of them or a platform admin). A title left out keeps the one on record; null clears it.
 */
export const setMyEntityRole = (id: string, role: EntityRole, title?: string | null) =>
  api.post(`/entities/${entitySegment(id)}/members`, title === undefined ? { role } : { role, title })
    .then((r) => r.data.data as EntityMembershipResult);

/** Leave, or withdraw a claim that still waits for the admins. */
export const leaveEntity = (id: string) =>
  api.delete(`/entities/${entitySegment(id)}/members/me`).then((r) => r.data.data as LeaveEntityResult);

// 30 Oct review (T15): the admins' answers. Its admins and platform admins only; the server says who may.

export const approveEntityMember = (id: string, userId: string) =>
  api.post(`/entities/${entitySegment(id)}/members/${entitySegment(userId)}/approve`);
export const declineEntityMember = (id: string, userId: string) =>
  api.post(`/entities/${entitySegment(id)}/members/${entitySegment(userId)}/decline`);
export const removeEntityMember = (id: string, userId: string) =>
  api.delete(`/entities/${entitySegment(id)}/members/${entitySegment(userId)}`);

// The logo and the banner (L1): a new picture with where it was placed, or a new place for the kept one.
export type EntityPictureKind = 'logo' | 'banner';
export interface EntityPictureBody { image?: string; crop: PictureCrop }

export const saveEntityPicture = (id: string, kind: EntityPictureKind, body: EntityPictureBody) =>
  api.put(`/entities/${entitySegment(id)}/${kind}`, body);
export const removeEntityPicture = (id: string, kind: EntityPictureKind) => api.delete(`/entities/${entitySegment(id)}/${kind}`);
/** The picture the editor opens on: the one the admin chose, with where they placed it. */
export const fetchEntityPictureSource = (id: string, kind: EntityPictureKind) =>
  api.get(`/entities/${entitySegment(id)}/${kind}/source`).then((r) => r.data.data as PictureSource);

// Shirley pilot S7 (brief item 15): what it offers, the whole list in order ([] clears it). Its admins and platform admins only.
export const setEntityServices = (id: string, body: SetEntityServicesBody) =>
  api.put(`/entities/${entitySegment(id)}/services`, body).then((r) => r.data.data.services as EntityService[]);
