import { generateUuid } from 'back-end/lib';
import { Connection, Transaction, tryDb } from 'back-end/lib/db';
import { readOneFileById } from 'back-end/lib/db/file';
import { readSubmittedCWUProposalCount } from 'back-end/lib/db/proposal/code-with-us';
import { RawCWUOpportunitySubscriber } from 'back-end/lib/db/subscribers/code-with-us';
import { readOneUserSlim } from 'back-end/lib/db/user';
import { valid } from 'shared/lib/http';
import { getCWUOpportunityViewsCounterName } from 'shared/lib/resources/counter';
import { FileRecord } from 'shared/lib/resources/file';
import { Addendum, CreateCWUOpportunityStatus, CWUOpportunity, CWUOpportunityEvent, CWUOpportunityHistoryRecord, CWUOpportunitySlim, CWUOpportunityStatus, privateOpportunitiesStatuses, publicOpportunityStatuses } from 'shared/lib/resources/opportunity/code-with-us';
import { CWUProposalStatus } from 'shared/lib/resources/proposal/code-with-us';
import { AuthenticatedSession, Session } from 'shared/lib/resources/session';
import { User, UserType } from 'shared/lib/resources/user';
import { adt, Id } from 'shared/lib/types';
import { getValidValue, isInvalid } from 'shared/lib/validation';

interface CreateCWUOpportunityParams extends Omit<CWUOpportunity, 'createdBy' | 'createdAt' | 'updatedAt' | 'updatedBy' | 'status' | 'id' | 'addenda'> {
  status: CreateCWUOpportunityStatus;
}

type UpdateCWUOpportunityParams = Partial<CWUOpportunity>;

interface RootOpportunityRecord {
  id: Id;
  createdAt: Date;
  createdBy: Id;
}

interface OpportunityVersionRecord extends Omit<CreateCWUOpportunityParams, 'status'> {
  id: Id;
  opportunity: Id;
  createdAt: Date;
  createdBy: Id;
}

interface RawCWUOpportunity extends Omit<CWUOpportunity, 'createdBy' | 'updatedBy' | 'attachments' | 'addenda'> {
  createdBy?: Id;
  updatedBy?: Id;
  attachments: Id[];
  addenda: Id[];
  versionId: string;
}

interface RawCWUOpportunitySlim extends Omit<CWUOpportunitySlim, 'createdBy' | 'updatedBy'> {
  createdBy?: Id;
  updatedBy?: Id;
}

interface RawCWUOpportunityAddendum extends Omit<Addendum, 'createdBy'> {
  createdBy?: Id;
}

interface RawCWUOpportunityHistoryRecord extends Omit<CWUOpportunityHistoryRecord, 'createdBy' | 'type'> {
  createdBy: Id | null;
  status?: CWUOpportunityStatus;
  event?: CWUOpportunityEvent;
}

async function rawCWUOpportunityToCWUOpportunity(connection: Connection, raw: RawCWUOpportunity): Promise<CWUOpportunity> {
  const { createdBy: createdById, updatedBy: updatedById, attachments: attachmentIds, addenda: addendaIds, ...restOfRaw } = raw;
  const createdBy = createdById ? getValidValue(await readOneUserSlim(connection, createdById), undefined) : undefined;
  const updatedBy = updatedById ? getValidValue(await readOneUserSlim(connection, updatedById), undefined) : undefined;
  const attachments = await Promise.all(attachmentIds.map(async id => {
    const result = getValidValue(await readOneFileById(connection, id), null);
    if (!result) {
      throw new Error('unable to process opportunity'); // to be caught by calling function
    }
    return result;
  }));
  const addenda = await Promise.all(addendaIds.map(async id => {
    const result = getValidValue(await readOneCWUOpportunityAddendum(connection, id), null);
    if (!result) {
      throw new Error('unable to retrieve addenda'); // to be caught by calling function
    }
    return result;
  }));

  delete raw.versionId;

  return {
    ...restOfRaw,
    createdBy: createdBy || undefined,
    updatedBy: updatedBy || undefined,
    attachments,
    addenda
  };
}

async function rawCWUOpportunitySlimToCWUOpportunitySlim(connection: Connection, raw: RawCWUOpportunitySlim): Promise<CWUOpportunitySlim> {
  const { createdBy: createdById, updatedBy: updatedById, ...restOfRaw } = raw;
  const createdBy = createdById && getValidValue(await readOneUserSlim(connection, createdById), undefined) || undefined;
  const updatedBy = updatedById && getValidValue(await readOneUserSlim(connection, updatedById), undefined) || undefined;
  return {
    ...restOfRaw,
    createdBy,
    updatedBy
  };
}

async function rawCWUOpportunityAddendumToCWUOpportunityAddendum(connection: Connection, raw: RawCWUOpportunityAddendum): Promise<Addendum> {
  const { createdBy: createdById, ...restOfRaw } = raw;
  const createdBy = createdById ? getValidValue(await readOneUserSlim(connection, createdById), undefined) : undefined;

  return {
    ...restOfRaw,
    createdBy: createdBy || undefined
  };
}

async function rawCWUOpportunityHistoryRecordToCWUOpportunityHistoryRecord(connection: Connection, session: Session, raw: RawCWUOpportunityHistoryRecord): Promise<CWUOpportunityHistoryRecord> {
  const { createdBy: createdById, status, event, ...restOfRaw } = raw;
  const createdBy = createdById ? getValidValue(await readOneUserSlim(connection, createdById), null) : null;

  if (!status && !event) {
    throw new Error('unable to process opportunity status record');
  }

  return {
    ...restOfRaw,
    createdBy,
    type: status ? adt('status', status as CWUOpportunityStatus) : adt('event', event as CWUOpportunityEvent)
  };
}

function processForRole<T extends RawCWUOpportunity | RawCWUOpportunitySlim>(result: T, session: Session) {
  // Remove createdBy/updatedBy for non-admin or non-author
  if (!session.user || (session.user.type !== UserType.Admin &&
    session.user.id !== result.createdBy &&
    session.user.id !== result.updatedBy)) {
      delete result.createdBy;
      delete result.updatedBy;
  }
  return result;
}

async function createCWUOpportunityAttachments(connection: Connection, trx: Transaction, oppVersionId: Id, attachments: FileRecord[]) {
  for (const attachment of attachments) {
    const [attachmentResult] = await connection('cwuOpportunityAttachments')
      .transacting(trx)
      .insert({
        opportunityVersion: oppVersionId,
        file: attachment.id
      }, '*');
    if (!attachmentResult) {
      throw new Error('Unable to create opportunity attachment');
    }
  }
}

export const readOneCWUOpportunity = tryDb<[Id, Session], CWUOpportunity | null>(async (connection, id, session) => {
  let query = connection<RawCWUOpportunity>('cwuOpportunities as opp')
    .where({ 'opp.id': id })
    // Join on latest CWU status
    .join<RawCWUOpportunity>('cwuOpportunityStatuses as stat', function() {
      this
        .on('opp.id', '=', 'stat.opportunity')
        .andOn('stat.createdAt', '=',
          connection.raw('(select max("createdAt") from "cwuOpportunityStatuses" as stat2 where \
            stat2.opportunity = opp.id and stat2.status is not null)'));
    })
    // Join on latest CWU version
    .join<RawCWUOpportunity>('cwuOpportunityVersions as version', function() {
      this
        .on('opp.id', '=', 'version.opportunity')
        .andOn('version.createdAt', '=',
          connection.raw('(select max("createdAt") from "cwuOpportunityVersions" as version2 where \
            version2.opportunity = opp.id)'));
    })
    .select<RawCWUOpportunity>(
      'opp.id',
      'opp.createdAt',
      'opp.createdBy',
      'version.id as versionId',
      'version.createdAt as updatedAt',
      'version.createdBy as updatedBy',
      'version.title',
      'version.teaser',
      'version.remoteOk',
      'version.remoteDesc',
      'version.location',
      'version.reward',
      'version.skills',
      'version.description',
      'version.proposalDeadline',
      'version.assignmentDate',
      'version.startDate',
      'version.completionDate',
      'version.submissionInfo',
      'version.acceptanceCriteria',
      'version.evaluationCriteria',
      'stat.status'
    );

  if (!session.user || session.user.type === UserType.Vendor) {
    // Anonymous users and vendors can only see public opportunities
    query = query
      .whereIn('stat.status', publicOpportunityStatuses as CWUOpportunityStatus[]);
  } else if (session.user.type === UserType.Government) {
    // Gov users should only see private opportunities they own, and public opportunities
    query = query
      .andWhere(function() {
        this
          .whereIn('stat.status', publicOpportunityStatuses as CWUOpportunityStatus[])
          .orWhere(function() {
            this
              .whereIn('stat.status', privateOpportunitiesStatuses as CWUOpportunityStatus[])
              .andWhere({ 'opp.createdBy': session.user?.id });
          });
      });
  } else {
    // Admin users can see both private and public opportunities
    query = query
      .whereIn('stat.status', [...publicOpportunityStatuses, ...privateOpportunitiesStatuses]);
  }

  let result = await query.first();

  // Query for attachment file ids
  if (result) {
    result = processForRole(result, session);
    result.attachments = (await connection<{ file: Id }>('cwuOpportunityAttachments')
      .where({ opportunityVersion: result.versionId })
      .select('file')).map(row => row.file);
    result.addenda = (await connection<{ id: Id }>('cwuOpportunityAddenda')
      .where({ opportunity: id })
      .select('id')).map(row => row.id);

    // Get published date if applicable
    const publishedDate = await connection<{ createdAt: Date}>('cwuOpportunityStatuses')
      .where({ opportunity: result.id, status: CWUOpportunityStatus.Published })
      .select('createdAt')
      .orderBy('createdAt', 'asc')
      .first();

    result.publishedAt = publishedDate?.createdAt;

    // Set awarded proponent flag if applicable
    if (result.status === CWUOpportunityStatus.Awarded) {
      result.successfulProponent = true;
    }

    // Add on subscription flag, if authenticated user
    if (session.user) {
      const subscription = await connection<RawCWUOpportunitySubscriber>('cwuOpportunitySubscribers')
        .where({ opportunity: result.id, user: session.user.id })
        .first();
      result.subscribed = !!subscription;
    }

    // If admin/owner, add on list of change records and reporting metrics if public
    if (session.user?.type === UserType.Admin || result.createdBy === session.user?.id) {
      const rawStatusArray = await connection<RawCWUOpportunityHistoryRecord>('cwuOpportunityStatuses')
        .where({ opportunity: result.id })
        .orderBy('createdAt', 'desc');

      result.history = await Promise.all(rawStatusArray.map(async raw => await rawCWUOpportunityHistoryRecordToCWUOpportunityHistoryRecord(connection, session, raw)));

      if (publicOpportunityStatuses.includes(result.status)) {
        // Retrieve opportunity views
        const numViews = (await connection<{ count: number }>('viewCounters')
        .where({ name: getCWUOpportunityViewsCounterName(result.id) })
        .first())?.count || 0;

        // Retrieve watchers/subscribers
        const numWatchers = (await connection('cwuOpportunitySubscribers')
          .where({ opportunity: result.id }))?.length || 0;

        // Retrieve number of submitted proposals (exclude draft/withdrawn)
        const numProposals = getValidValue(await readSubmittedCWUProposalCount(connection, result.id), 0);

        result.reporting = {
          numViews,
          numWatchers,
          numProposals
        };
      }
    }
  }

  return valid(result ? await rawCWUOpportunityToCWUOpportunity(connection, result) : null);
});

export const readOneCWUOpportunitySlim = tryDb<[Id, Session], CWUOpportunitySlim | null>(async (connection, oppId, session) => {
  // Since slim opportunity requires the same joins, etc. as full to build, we query the full one, and reduce down to slim
  const dbResult = await readOneCWUOpportunity(connection, oppId, session);
  if (isInvalid(dbResult) || !dbResult.value) {
    throw new Error('unable to read opportunity');
  }

  const fullOpportunity = dbResult.value;
  const { id, createdAt, createdBy, updatedAt, updatedBy, title, proposalDeadline, status } = fullOpportunity;
  return valid({
    id,
    createdAt,
    createdBy,
    updatedAt,
    updatedBy,
    title,
    proposalDeadline,
    status
  });
});

export const readOneCWUOpportunityAddendum = tryDb<[Id], Addendum>(async (connection, id) => {
  const result = await connection<RawCWUOpportunityAddendum>('cwuOpportunityAddenda')
    .where({ id })
    .first();

  if (!result) {
    throw new Error('unable to read addendum');
  }

  return valid(await rawCWUOpportunityAddendumToCWUOpportunityAddendum(connection, result));
});

export const readManyCWUOpportunities = tryDb<[Session], CWUOpportunitySlim[]>(async (connection, session) => {
  // Retrieve the opportunity and most recent opportunity status

  let query = connection<RawCWUOpportunitySlim>('cwuOpportunities as opp')
    // Join on latest CWU status
    .join<RawCWUOpportunitySlim>('cwuOpportunityStatuses as stat', function() {
      this
        .on('opp.id', '=', 'stat.opportunity')
        .andOn('stat.createdAt', '=',
          connection.raw('(select max("createdAt") from "cwuOpportunityStatuses" as stat2 where \
            stat2.opportunity = opp.id)'));
    })
    // Join on latest CWU version
    .join<RawCWUOpportunitySlim>('cwuOpportunityVersions as version', function() {
      this
        .on('opp.id', '=', 'version.opportunity')
        .andOn('version.createdAt', '=',
          connection.raw('(select max("createdAt") from "cwuOpportunityVersions" as version2 where \
            version2.opportunity = opp.id)'));
    })
    // Select fields for 'slim' opportunity
    .select<RawCWUOpportunitySlim[]>(
      'opp.id',
      'version.title',
      'opp.createdBy',
      'opp.createdAt',
      'version.createdAt as updatedAt',
      'version.createdBy as updatedBy',
      'version.proposalDeadline',
      'stat.status'
    );

  if (!session.user || session.user.type === UserType.Vendor) {
    // Anonymous users and vendors can only see public opportunities
    query = query
      .whereIn('stat.status', publicOpportunityStatuses as CWUOpportunityStatus[]);
  } else if (session.user.type === UserType.Government) {
    // Gov users should only see private opportunities they own, and public opportunities
    query = query
      .whereIn('stat.status', publicOpportunityStatuses as CWUOpportunityStatus[])
      .orWhere(function() {
        this
          .whereIn('stat.status', privateOpportunitiesStatuses as CWUOpportunityStatus[])
          .andWhere({ 'opp.createdBy': session.user?.id });
      });
  }
  // Admins can see all opportunities, so no additional filter necessary if none of the previous conditions match
  // Process results to eliminate fields not viewable by the current role
  const results = (await query).map(result => processForRole(result, session));
  return valid(await Promise.all(results.map(async raw => await rawCWUOpportunitySlimToCWUOpportunitySlim(connection, raw))));
});

export const createCWUOpportunity = tryDb<[CreateCWUOpportunityParams, AuthenticatedSession], CWUOpportunity>(async (connection, opportunity, session) => {
  // Create root opportunity record
  const now = new Date();
  const opportunityId = await connection.transaction(async trx => {
    const [rootOppRecord] = await connection<RootOpportunityRecord>('cwuOpportunities')
      .transacting(trx)
      .insert({
        id: generateUuid(),
        createdAt: now,
        createdBy: session.user.id
      }, '*');

    if (!rootOppRecord) {
      throw new Error('unable to create opportunity root record');
    }

    // Create initial opportunity version
    const { attachments, status, ...restOfOpportunity } = opportunity;
    const [oppVersionRecord] = await connection<OpportunityVersionRecord>('cwuOpportunityVersions')
      .transacting(trx)
      .insert({
        ...restOfOpportunity,
        id: generateUuid(),
        opportunity: rootOppRecord.id,
        createdAt: now,
        createdBy: session.user.id
      }, '*');

    if (!oppVersionRecord) {
      throw new Error('unable to create opportunity version');
    }

    // Create initial opportunity status record (Draft)
    await connection('cwuOpportunityStatuses')
      .transacting(trx)
      .insert({
        id: generateUuid(),
        opportunity: rootOppRecord.id,
        createdAt: now,
        createdBy: session.user.id,
        status,
        note: ''
      }, '*');

    // Create attachment records
    await createCWUOpportunityAttachments(connection, trx, oppVersionRecord.id, attachments);

    return rootOppRecord.id;
  });

  const dbResult = await readOneCWUOpportunity(connection, opportunityId, session);
  if (isInvalid(dbResult) || !dbResult.value) {
    throw new Error('unable to create opportunity');
  }
  return valid(dbResult.value);
});

export async function isCWUOpportunityAuthor(connection: Connection, user: User, id: Id): Promise<boolean> {
  try {
    const result = await connection<RawCWUOpportunity>('cwuOpportunities')
      .select('*')
      .where({ id, createdBy: user.id });
    return !!result && result.length > 0;
  } catch (exception) {
    return false;
  }
}

export const updateCWUOpportunityVersion = tryDb<[UpdateCWUOpportunityParams, AuthenticatedSession], CWUOpportunity>(async (connection, opportunity, session) => {
  const now = new Date();
  const { attachments, ...restOfOpportunity } = opportunity;
  const oppVersion = await connection.transaction(async trx => {
    const [oppVersion] = await connection<OpportunityVersionRecord>('cwuOpportunityVersions')
      .transacting(trx)
      .insert({
        ...restOfOpportunity,
        opportunity: restOfOpportunity.id,
        id: generateUuid(),
        createdAt: now,
        createdBy: session.user.id
      }, '*');

    if (!oppVersion) {
      throw new Error('unable to update opportunity');
    }
    await createCWUOpportunityAttachments(connection, trx, oppVersion.id, attachments || []);

    // Add an 'edit' change record
    await connection<RawCWUOpportunityHistoryRecord & { opportunity: Id }>('cwuOpportunityStatuses')
      .insert({
        id: generateUuid(),
        opportunity: restOfOpportunity.id,
        createdAt: now,
        createdBy: session.user.id,
        event: CWUOpportunityEvent.Edited,
        note: ''
      });

    return oppVersion;
  });
  const dbResult = await readOneCWUOpportunity(connection, oppVersion.opportunity, session);
  if (isInvalid(dbResult) || !dbResult.value) {
    throw new Error('unable to update opportunity');
  }
  return valid(dbResult.value);
});

export const updateCWUOpportunityStatus = tryDb<[Id, CWUOpportunityStatus, string, AuthenticatedSession], CWUOpportunity>(async (connection, id, status, note, session) => {
  const now = new Date();
  const [result] = await connection<RawCWUOpportunityHistoryRecord & { opportunity: Id }>('cwuOpportunityStatuses')
    .insert({
      id: generateUuid(),
      opportunity: id,
      createdAt: now,
      createdBy: session.user.id,
      status,
      note
    }, '*');

  if (!result) {
    throw new Error('unable to update opportunity');
  }

  const dbResult = await readOneCWUOpportunity(connection, id, session);
  if (isInvalid(dbResult) || !dbResult.value) {
    throw new Error('unable to update opportunity');
  }

  return valid(dbResult.value);
});

export const addCWUOpportunityAddendum = tryDb<[Id, string, AuthenticatedSession], CWUOpportunity>(async (connection, id, addendumText, session) => {
  const now = new Date();
  await connection.transaction(async trx => {
    const [addendum] = await connection<RawCWUOpportunityAddendum & { opportunity: Id }>('cwuOpportunityAddenda')
      .transacting(trx)
      .insert({
        id: generateUuid(),
        opportunity: id,
        description: addendumText,
        createdBy: session.user.id,
        createdAt: now
      }, '*');

    if (!addendum) {
      throw new Error('unable to add addendum');
    }

    // Add a history record for the addendum addition
    await connection<RawCWUOpportunityHistoryRecord & { opportunity: Id }>('cwuOpportunityStatuses')
      .transacting(trx)
      .insert({
        id: generateUuid(),
        opportunity: id,
        createdAt: now,
        createdBy: session.user.id,
        event: CWUOpportunityEvent.AddendumAdded,
        note: ''
      });
  });

  const dbResult = await readOneCWUOpportunity(connection, id, session);
  if (isInvalid(dbResult) || !dbResult.value) {
    throw new Error('unable to add addendum');
  }
  return valid(dbResult.value);
});

export const deleteCWUOpportunity = tryDb<[Id], CWUOpportunity>(async (connection, id) => {
  // Delete root record - cascade relationships in database will cleanup versions/attachments/addenda automatically
  const [result] = await connection<RawCWUOpportunity>('cwuOpportunities')
    .where({ id })
    .delete('*');

  if (!result) {
    throw new Error('unable to delete opportunity');
  }
  result.addenda = [];
  result.attachments = [];
  return valid(await rawCWUOpportunityToCWUOpportunity(connection, result));
});

export const closeCWUOpportunities = tryDb<[], number>(async (connection) => {
  const now = new Date();
  return valid(await connection.transaction(async trx => {
    const lapsedOpportunitiesIds = (await connection<{ id: Id }>('cwuOpportunities as opportunities')
      .transacting(trx)
      .join('cwuOpportunityStatuses as statuses', function() {
        this
          .on('opportunities.id', '=', 'statuses.opportunity')
          .andOn('statuses.createdAt', '=',
            connection.raw('(select max("createdAt") from "cwuOpportunityStatuses" as statuses2 where \
              statuses2.opportunity = opportunities.id and statuses2.status is not null)'));
      })
      .join('cwuOpportunityVersions as versions', function() {
        this
          .on('opportunities.id', '=', 'versions.opportunity')
          .andOn('versions.createdAt', '=',
            connection.raw('(select max("createdAt") from "cwuOpportunityVersions" as versions2 where \
              versions2.opportunity = opportunities.id)'));
      })
      .where({
        'statuses.status': CWUOpportunityStatus.Published
      })
      .andWhere('versions.proposalDeadline', '<=', now)
      .select<Array<{ id: Id }>>('opportunities.id'))?.map(result => result.id) || [];

    for (const lapsedOpportunityId of lapsedOpportunitiesIds) {
      // Set the opportunity to EVALUATION status
      await connection('cwuOpportunityStatuses')
        .transacting(trx)
        .insert({
          id: generateUuid(),
          createdAt: now,
          opportunity: lapsedOpportunityId,
          status: CWUOpportunityStatus.Evaluation,
          note: 'This opportunity has closed.'
        });

      // Get a list of SUBMITTED proposals for this opportunity
      const proposalIds = (await connection<{ id: Id }>('cwuProposals as proposals')
        .transacting(trx)
        .join('cwuProposalStatuses as statuses', function() {
          this
            .on('proposals.id', '=', 'statuses.proposal')
            .andOnNotNull('statuses.status')
            .andOn('statuses.createdAt', '=',
              connection.raw('(select max("createdAt") from "cwuProposalStatuses" as statuses2 where \
                statuses2.proposal = proposals.id and statuses2.status is not null)'));
        })
        .where({
          'proposals.opportunity': lapsedOpportunityId,
          'statuses.status': CWUProposalStatus.Submitted
        })
        .select<Array<{ id: Id }>>('proposals.id'))?.map(result => result.id) || [];

      for (const proposalId of proposalIds) {
        // Set the proposal to UNDER_REVIEW status
        await connection('cwuProposalStatuses')
          .transacting(trx)
          .insert({
            id: generateUuid(),
            createdAt: now,
            proposal: proposalId,
            status: CWUProposalStatus.UnderReview,
            note: ''
          });
      }
    }
    return lapsedOpportunitiesIds.length;
  }));
});
