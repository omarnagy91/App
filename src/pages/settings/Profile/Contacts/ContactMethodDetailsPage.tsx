import type {StackScreenProps} from '@react-navigation/stack';
import Str from 'expensify-common/lib/str';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {InteractionManager, Keyboard, ScrollView, View} from 'react-native';
import type {OnyxCollection, OnyxEntry} from 'react-native-onyx';
import {withOnyx} from 'react-native-onyx';
import FullPageNotFoundView from '@components/BlockingViews/FullPageNotFoundView';
import ConfirmModal from '@components/ConfirmModal';
import DotIndicatorMessage from '@components/DotIndicatorMessage';
import FullscreenLoadingIndicator from '@components/FullscreenLoadingIndicator';
import HeaderWithBackButton from '@components/HeaderWithBackButton';
import * as Expensicons from '@components/Icon/Expensicons';
import MenuItem from '@components/MenuItem';
import OfflineWithFeedback from '@components/OfflineWithFeedback';
import ScreenWrapper from '@components/ScreenWrapper';
import Text from '@components/Text';
import useLocalize from '@hooks/useLocalize';
import usePrevious from '@hooks/usePrevious';
import useTheme from '@hooks/useTheme';
import useThemeStyles from '@hooks/useThemeStyles';
import {canUseTouchScreen} from '@libs/DeviceCapabilities';
import * as ErrorUtils from '@libs/ErrorUtils';
import Navigation from '@libs/Navigation/Navigation';
import type {SettingsNavigatorParamList} from '@libs/Navigation/types';
import * as Session from '@userActions/Session';
import * as User from '@userActions/User';
import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import ROUTES from '@src/ROUTES';
import type SCREENS from '@src/SCREENS';
import type {LoginList, Policy, SecurityGroup, Session as TSession} from '@src/types/onyx';
import {isEmptyObject} from '@src/types/utils/EmptyObject';
import ValidateCodeForm from './ValidateCodeForm';
import type {ValidateCodeFormHandle} from './ValidateCodeForm/BaseValidateCodeForm';

type ContactMethodDetailsPageOnyxProps = {
    /** Login list for the user that is signed in */
    loginList: OnyxEntry<LoginList>;

    /** Current user session */
    session: OnyxEntry<TSession>;

    /** User's security group IDs by domain */
    myDomainSecurityGroups: OnyxEntry<Record<string, string>>;

    /** All of the user's security groups and their settings */
    securityGroups: OnyxCollection<SecurityGroup>;

    /** Indicated whether the report data is loading */
    isLoadingReportData: OnyxEntry<boolean>;

    /** The list of this user's policies */
    policies: OnyxCollection<Pick<Policy, 'id' | 'ownerAccountID' | 'owner'>>;
};

type ContactMethodDetailsPageProps = ContactMethodDetailsPageOnyxProps & StackScreenProps<SettingsNavigatorParamList, typeof SCREENS.SETTINGS.PROFILE.CONTACT_METHOD_DETAILS>;

function ContactMethodDetailsPage({loginList, session, myDomainSecurityGroups, securityGroups, isLoadingReportData = true, route, policies}: ContactMethodDetailsPageProps) {
    const {formatPhoneNumber, translate} = useLocalize();
    const theme = useTheme();
    const themeStyles = useThemeStyles();

    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const validateCodeFormRef = useRef<ValidateCodeFormHandle>(null);

    /**
     * Gets the current contact method from the route params
     */
    const contactMethod: string = useMemo(() => {
        const contactMethodParam = route.params.contactMethod;

        // We find the number of times the url is encoded based on the last % sign and remove them.
        const lastPercentIndex = contactMethodParam.lastIndexOf('%');
        const encodePercents = contactMethodParam.substring(lastPercentIndex).match(new RegExp('25', 'g'));
        let numberEncodePercents = encodePercents?.length ?? 0;
        const beforeAtSign = contactMethodParam.substring(0, lastPercentIndex).replace(CONST.REGEX.ENCODE_PERCENT_CHARACTER, (match) => {
            if (numberEncodePercents > 0) {
                numberEncodePercents--;
                return '%';
            }
            return match;
        });
        const afterAtSign = contactMethodParam.substring(lastPercentIndex).replace(CONST.REGEX.ENCODE_PERCENT_CHARACTER, '%');

        return decodeURIComponent(beforeAtSign + afterAtSign);
    }, [route.params.contactMethod]);
    const loginData = useMemo(() => loginList?.[contactMethod], [loginList, contactMethod]);
    const isDefaultContactMethod = useMemo(() => session?.email === loginData?.partnerUserID, [session?.email, loginData?.partnerUserID]);

    /**
     * Attempt to set this contact method as user's "Default contact method"
     */
    const setAsDefault = useCallback(() => {
        User.setContactMethodAsDefault(contactMethod, policies);
    }, [contactMethod, policies]);

    /**
     * Checks if the user is allowed to change their default contact method. This should only be allowed if:
     * 1. The viewed contact method is not already their default contact method
     * 2. The viewed contact method is validated
     * 3. If the user is on a private domain, their security group must allow primary login switching
     */
    const canChangeDefaultContactMethod = useMemo(() => {
        // Cannot set this contact method as default if:
        // 1. This contact method is already their default
        // 2. This contact method is not validated
        if (isDefaultContactMethod || !loginData?.validatedDate) {
            return false;
        }

        const domainName = Str.extractEmailDomain(session?.email ?? '');
        const primaryDomainSecurityGroupID = myDomainSecurityGroups?.[domainName];

        // If there's no security group associated with the user for the primary domain,
        // default to allowing the user to change their default contact method.
        if (!primaryDomainSecurityGroupID) {
            return true;
        }

        // Allow user to change their default contact method if they don't have a security group OR if their security group
        // does NOT restrict primary login switching.
        return !securityGroups?.[`${ONYXKEYS.COLLECTION.SECURITY_GROUP}${primaryDomainSecurityGroupID}`]?.hasRestrictedPrimaryLogin;
    }, [isDefaultContactMethod, loginData?.validatedDate, session?.email, myDomainSecurityGroups, securityGroups]);

    /**
     * Toggle delete confirm modal visibility
     */
    const toggleDeleteModal = useCallback((isOpen: boolean) => {
        if (canUseTouchScreen() && isOpen) {
            InteractionManager.runAfterInteractions(() => {
                setIsDeleteModalOpen(isOpen);
            });
            Keyboard.dismiss();
        } else {
            setIsDeleteModalOpen(isOpen);
        }
    }, []);

    /**
     * Delete the contact method and hide the modal
     */
    const confirmDeleteAndHideModal = useCallback(() => {
        toggleDeleteModal(false);
        User.deleteContactMethod(contactMethod, loginList ?? {});
    }, [contactMethod, loginList, toggleDeleteModal]);

    useEffect(() => {
        if (isEmptyObject(loginData)) {
            return;
        }
        User.resetContactMethodValidateCodeSentState(contactMethod);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const prevValidatedDate = usePrevious(loginData?.validatedDate);
    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        if (prevValidatedDate || !loginData?.validatedDate) {
            return;
        }

        // If the selected contactMethod is the current session['login'] and the account is unvalidated,
        // the current authToken is invalid after the successful magic code verification.
        // So we need to sign out the user and redirect to the sign in page.
        if (isDefaultContactMethod) {
            Session.signOutAndRedirectToSignIn();
            return;
        }
        // Navigate to methods page on successful magic code verification
        // validatedDate property is responsible to decide the status of the magic code verification
        Navigation.goBack(ROUTES.SETTINGS_CONTACT_METHODS.route);
    }, [prevValidatedDate, loginData?.validatedDate, isDefaultContactMethod]);

    if (isLoadingReportData && isEmptyObject(loginList)) {
        return <FullscreenLoadingIndicator />;
    }

    if (!contactMethod || !loginData) {
        return (
            <ScreenWrapper testID={ContactMethodDetailsPage.displayName}>
                <FullPageNotFoundView
                    shouldShow
                    linkKey="contacts.goBackContactMethods"
                    onBackButtonPress={() => Navigation.goBack(ROUTES.SETTINGS_CONTACT_METHODS.route)}
                    onLinkPress={() => Navigation.goBack(ROUTES.SETTINGS_CONTACT_METHODS.route)}
                />
            </ScreenWrapper>
        );
    }

    // Replacing spaces with "hard spaces" to prevent breaking the number
    const formattedContactMethod = Str.isSMSLogin(contactMethod) ? formatPhoneNumber(contactMethod).replace(/ /g, '\u00A0') : contactMethod;
    const hasMagicCodeBeenSent = !!loginData.validateCodeSent;
    const isFailedAddContactMethod = !!loginData.errorFields?.addedLogin;
    const isFailedRemovedContactMethod = !!loginData.errorFields?.deletedLogin;

    return (
        <ScreenWrapper
            onEntryTransitionEnd={() => validateCodeFormRef.current?.focus?.()}
            testID={ContactMethodDetailsPage.displayName}
        >
            <HeaderWithBackButton
                title={formattedContactMethod}
                onBackButtonPress={() => Navigation.goBack(ROUTES.SETTINGS_CONTACT_METHODS.route)}
            />
            <ScrollView keyboardShouldPersistTaps="handled">
                <ConfirmModal
                    title={translate('contacts.removeContactMethod')}
                    onConfirm={confirmDeleteAndHideModal}
                    onCancel={() => toggleDeleteModal(false)}
                    onModalHide={() => {
                        InteractionManager.runAfterInteractions(() => {
                            validateCodeFormRef.current?.focusLastSelected?.();
                        });
                    }}
                    prompt={translate('contacts.removeAreYouSure')}
                    confirmText={translate('common.yesContinue')}
                    cancelText={translate('common.cancel')}
                    isVisible={isDeleteModalOpen && !isDefaultContactMethod}
                    danger
                />

                {isFailedAddContactMethod && (
                    <DotIndicatorMessage
                        style={[themeStyles.mh5, themeStyles.mv3]}
                        messages={ErrorUtils.getLatestErrorField(loginData, 'addedLogin')}
                        type="error"
                    />
                )}

                {!loginData.validatedDate && !isFailedAddContactMethod && (
                    <View style={[themeStyles.ph5, themeStyles.mt3, themeStyles.mb7]}>
                        <DotIndicatorMessage
                            type="success"
                            style={[themeStyles.mb3]}
                            // eslint-disable-next-line @typescript-eslint/naming-convention
                            messages={{0: ['contacts.enterMagicCode', {contactMethod: formattedContactMethod}]}}
                        />

                        <ValidateCodeForm
                            contactMethod={contactMethod}
                            hasMagicCodeBeenSent={hasMagicCodeBeenSent}
                            loginList={loginList ?? {}}
                            ref={validateCodeFormRef}
                        />
                    </View>
                )}
                {canChangeDefaultContactMethod ? (
                    <OfflineWithFeedback
                        errors={ErrorUtils.getLatestErrorField(loginData, 'defaultLogin')}
                        errorRowStyles={[themeStyles.ml8, themeStyles.mr5]}
                        onClose={() => User.clearContactMethodErrors(contactMethod, 'defaultLogin')}
                    >
                        <MenuItem
                            title={translate('contacts.setAsDefault')}
                            icon={Expensicons.Profile}
                            onPress={setAsDefault}
                        />
                    </OfflineWithFeedback>
                ) : null}
                {isDefaultContactMethod ? (
                    <OfflineWithFeedback
                        pendingAction={loginData.pendingFields?.defaultLogin}
                        errors={ErrorUtils.getLatestErrorField(loginData, isFailedRemovedContactMethod ? 'deletedLogin' : 'defaultLogin')}
                        errorRowStyles={[themeStyles.ml8, themeStyles.mr5]}
                        onClose={() => User.clearContactMethodErrors(contactMethod, isFailedRemovedContactMethod ? 'deletedLogin' : 'defaultLogin')}
                    >
                        <Text style={[themeStyles.ph5, themeStyles.mv3]}>{translate('contacts.yourDefaultContactMethod')}</Text>
                    </OfflineWithFeedback>
                ) : (
                    <OfflineWithFeedback
                        pendingAction={loginData.pendingFields?.deletedLogin}
                        errors={ErrorUtils.getLatestErrorField(loginData, 'deletedLogin')}
                        errorRowStyles={[themeStyles.mt6, themeStyles.ph5]}
                        onClose={() => User.clearContactMethodErrors(contactMethod, 'deletedLogin')}
                    >
                        <MenuItem
                            title={translate('common.remove')}
                            icon={Expensicons.Trashcan}
                            iconFill={theme.danger}
                            onPress={() => toggleDeleteModal(true)}
                        />
                    </OfflineWithFeedback>
                )}
            </ScrollView>
        </ScreenWrapper>
    );
}

ContactMethodDetailsPage.displayName = 'ContactMethodDetailsPage';

export default withOnyx<ContactMethodDetailsPageProps, ContactMethodDetailsPageOnyxProps>({
    loginList: {
        key: ONYXKEYS.LOGIN_LIST,
    },
    session: {
        key: ONYXKEYS.SESSION,
    },
    myDomainSecurityGroups: {
        key: ONYXKEYS.MY_DOMAIN_SECURITY_GROUPS,
    },
    securityGroups: {
        key: `${ONYXKEYS.COLLECTION.SECURITY_GROUP}`,
    },
    isLoadingReportData: {
        key: `${ONYXKEYS.IS_LOADING_REPORT_DATA}`,
    },
    policies: {
        key: ONYXKEYS.COLLECTION.POLICY,
        selector: (data) => ({
            id: data?.id ?? '',
            ownerAccountID: data?.ownerAccountID,
            owner: data?.owner ?? '',
        }),
    },
})(ContactMethodDetailsPage);
