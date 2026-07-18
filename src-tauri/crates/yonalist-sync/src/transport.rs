use crate::{DeviceId, GrantId, MemberId};
use crate::{
    PackBytes, PackLimits, PackRequest, Plane, ProjectId, RefAdvertisement, SessionToken,
    SignedAtom, SyncError,
};

#[derive(Clone, Debug)]
pub struct Hello {
    pub project_id: ProjectId,
    pub member_id: MemberId,
    pub device_id: DeviceId,
    pub grant_id: GrantId,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HelloAck {
    Allowed { session: SessionToken },
    RemovalOnly { notice: SignedAtom },
    Denied,
}

pub trait PeerEndpoint {
    fn hello(&mut self, hello: &Hello) -> Result<HelloAck, SyncError>;
    fn advertise(
        &mut self,
        session: &SessionToken,
        project: ProjectId,
        plane: Plane,
    ) -> Result<RefAdvertisement, SyncError>;
    fn create_pack(
        &mut self,
        session: &SessionToken,
        project: ProjectId,
        request: &PackRequest,
        limits: &PackLimits,
    ) -> Result<PackBytes, SyncError>;
}
