import { Id } from 'shared/lib/types';

export enum UserType {
    Vendor = 'VENDOR',
    Government = 'GOV',
    Admin = 'ADMIN'
}

export enum UserStatus {
    Active = 'ACTIVE',
    InactiveByUser = 'INACTIVE_USER',
    InactiveByAdmin = 'INACTIVE_ADMIN'
}

export interface User {
    id: Id;
    type: UserType;
    status: UserStatus;
    name: string;
    email?: string;
    avatarImageUrl?: string;
    notificationsOn: boolean;
    acceptedTerms: boolean;
    idpUsername: string;
}